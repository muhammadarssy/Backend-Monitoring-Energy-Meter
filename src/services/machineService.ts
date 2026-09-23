import { readFileSync } from 'fs';
import { resolve } from 'path';
import { env } from '../config/env.js';
import {
  DeviceInfoHash,
  MeterRef,
  ReadingPayload,
  getDeviceInfo,
  getLatest,
} from '../lib/redisClient.js';
import { scaledEnergyKwh, scaledPowerKw } from './redisScaling.js';

export type MachineStatus = 'running' | 'idle' | 'offline';

export interface MachineMeta {
  name: string;
  sector: string;
  type: string;
  calibration_class: string;
}

interface MetaFile {
  _default: MachineMeta;
  [meterId: string]: MachineMeta | string | undefined;
}

// Dibaca relatif terhadap root project (server dijalankan dari folder project).
const META_PATH = resolve(process.cwd(), 'src', 'config', 'machines.json');
let META: MetaFile;
try {
  META = JSON.parse(readFileSync(META_PATH, 'utf-8')) as MetaFile;
} catch (e: any) {
  console.error(`[meta] gagal baca ${META_PATH}: ${e.message}`);
  META = { _default: { name: 'Unknown Machine', sector: 'Unassigned', type: 'Energy Meter', calibration_class: '0.5S' } };
}

export function getMeta(meterId: string): MachineMeta {
  const entry = META[meterId];
  if (entry && typeof entry === 'object') return entry as MachineMeta;
  return META._default;
}

const META_SKIP = new Set(['_default', '_comment']);

/** Meter yang terdaftar di machines.json (bukan Unknown / _default). */
export function listKnownMeters(): { id: string; meta: MachineMeta }[] {
  const out: { id: string; meta: MachineMeta }[] = [];
  for (const [id, entry] of Object.entries(META)) {
    if (META_SKIP.has(id) || !entry || typeof entry !== 'object') continue;
    const meta = entry as MachineMeta;
    if (/^unknown/i.test(String(meta.name || '').trim())) continue;
    out.push({ id, meta });
  }
  return out;
}

// ── Helper waktu / zona ────────────────────────────────────────────────────
const pad = (n: number) => n.toString().padStart(2, '0');

/** Date -> "YYYY-MM-DDTHH:MM:SS+07:00" sesuai TZ_OFFSET_MINUTES. */
export function isoWithOffset(date: Date): string {
  const off = env.tzOffsetMinutes;
  const shifted = new Date(date.getTime() + off * 60000);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const oh = pad(Math.floor(abs / 60));
  const om = pad(abs % 60);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

/** Jam lokal "HH:MM:SS" sesuai offset. */
export function localTimeStr(date = new Date()): string {
  const shifted = new Date(date.getTime() + env.tzOffsetMinutes * 60000);
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
}

/** Komponen tanggal/jam lokal (dipakai endpoint device-info untuk register RTC). */
export function localParts(date = new Date()) {
  const shifted = new Date(date.getTime() + env.tzOffsetMinutes * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

/** Awal hari ini (lokal) dalam UTC. */
export function todayStartUtc(now = new Date()): Date {
  const p = localParts(now);
  const localMidnightUtcMs = Date.UTC(p.year, p.month - 1, p.day, 0, 0, 0);
  return new Date(localMidnightUtcMs - env.tzOffsetMinutes * 60000);
}

/** Batas 7 hari terakhir (termasuk hari ini), berurutan lama -> baru. */
export function last7Days(now = new Date()): { date: string; startUtc: Date; endUtc: Date }[] {
  const p = localParts(now);
  const days: { date: string; startUtc: Date; endUtc: Date }[] = [];
  for (let i = 6; i >= 0; i--) {
    const localMidnightUtcMs = Date.UTC(p.year, p.month - 1, p.day - i, 0, 0, 0);
    const startUtc = new Date(localMidnightUtcMs - env.tzOffsetMinutes * 60000);
    const endUtc = new Date(startUtc.getTime() + 86400000);
    const ld = new Date(localMidnightUtcMs);
    const date = `${ld.getUTCFullYear()}-${pad(ld.getUTCMonth() + 1)}-${pad(ld.getUTCDate())}`;
    days.push({ date, startUtc, endUtc });
  }
  return days;
}

// ── Akses nilai sample ─────────────────────────────────────────────────────
export function val(payload: ReadingPayload | null, field: string): number | null {
  if (!payload) return null;
  const v = payload.values?.[field];
  return v === null || v === undefined || Number.isNaN(v) ? null : Number(v);
}

/** Daya total dalam kW dari Redis (setelah ratio CT/PT). */
export function powerKw(payload: ReadingPayload | null): number {
  return scaledPowerKw(payload);
}

/** Energi kumulatif kWh dari Redis (Ep * UrAt * IrAt). */
export function energyKwh(payload: ReadingPayload | null): number {
  return scaledEnergyKwh(payload);
}

// ── Konteks mesin (gabungan Redis latest + device_info + metadata) ─────────
export interface MachineContext {
  ref: MeterRef;
  meta: MachineMeta;
  latest: ReadingPayload | null;
  deviceInfo: DeviceInfoHash;
  status: MachineStatus;
}

export function deriveStatus(latest: ReadingPayload | null, now = new Date()): MachineStatus {
  if (!latest || !latest.timestamp) return 'offline';
  const ts = new Date(latest.timestamp).getTime();
  if (Number.isNaN(ts)) return 'offline';
  const ageSec = (now.getTime() - ts) / 1000;
  if (ageSec > env.offlineThresholdSeconds) return 'offline';
  const state = (latest.gpio_state || '').toUpperCase();
  if (state === 'SAVING' || state === 'COOLING') return 'running';
  return 'idle';
}

export async function loadMachineContext(ref: MeterRef): Promise<MachineContext> {
  const [latest, deviceInfo] = await Promise.all([getLatest(ref), getDeviceInfo(ref)]);
  return {
    ref,
    meta: getMeta(ref.meterId),
    latest,
    deviceInfo,
    status: deriveStatus(latest),
  };
}

// ── Helper device_info ─────────────────────────────────────────────────────
export function diNumber(di: DeviceInfoHash, field: string, fallback: number): number {
  const raw = di?.[field];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isNaN(n) ? fallback : n;
}

/** network_mode: 0 = 3P4W, 1 = 3P3W. */
export function networkModeLabel(di: DeviceInfoHash): '3P4W' | '3P3W' {
  const n = diNumber(di, 'network_mode', 0);
  return n === 1 ? '3P3W' : '3P4W';
}
