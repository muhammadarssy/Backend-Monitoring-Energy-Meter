import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * Klien Redis untuk membaca mirror buffer & device info yang dipublish collector.
 *
 * Pola key (lihat STORAGE_SCHEMA.md):
 *   {prefix}:{collector_id}:meter:{meter_id}:latest      (String JSON)
 *   {prefix}:{collector_id}:meter:{meter_id}:readings    (List JSON, terbaru di index 0)
 *   {prefix}:{collector_id}:meter:{meter_id}:device_info (Hash)
 */

export interface ReadingPayload {
  collector_id: string;
  meter_id: string;
  timestamp: string;
  session_id: string | null;
  cycle_id: string | null;
  gpio_state?: string;
  values: Record<string, number | null>;
}

export interface DeviceInfoHash {
  network_mode?: string;
  meter_type?: string;
  slave_id_register?: string;
  baudrate_register?: string;
  collector_id?: string;
  meter_id?: string;
  updated_at?: string;
  [k: string]: string | undefined;
}

export interface MeterRef {
  collectorId: string;
  meterId: string;
}

export const redis = new Redis(env.redisUrl, {
  lazyConnect: false,
  maxRetriesPerRequest: 2,
});

redis.on('error', (err: Error) => {
  console.error(`[redis] ${err.message}`);
});

const P = env.redisKeyPrefix;

const key = (collectorId: string, meterId: string, suffix: string) =>
  `${P}:${collectorId}:meter:${meterId}:${suffix}`;

/** Temukan semua meter yang tersedia di Redis via SCAN (multi-collector, multi-meter). */
export async function discoverMeters(): Promise<MeterRef[]> {
  const pattern = `${P}:*:meter:*:latest`;
  const found: MeterRef[] = [];
  const seen = new Set<string>();
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    for (const k of keys) {
      // {prefix}:{collector}:meter:{meter}:latest
      const parts = k.split(':');
      const meterIdx = parts.indexOf('meter');
      if (meterIdx === -1 || meterIdx < 1 || meterIdx + 1 >= parts.length) continue;
      const collectorId = parts.slice(1, meterIdx).join(':');
      const meterId = parts[meterIdx + 1];
      const dedup = `${collectorId}::${meterId}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      found.push({ collectorId, meterId });
    }
  } while (cursor !== '0');

  found.sort((a, b) => a.meterId.localeCompare(b.meterId));
  return found;
}

/** Cari collector pemilik suatu meterId (ambil yang pertama ditemukan). */
export async function findMeter(meterId: string): Promise<MeterRef | null> {
  const meters = await discoverMeters();
  return meters.find((m) => m.meterId.toLowerCase() === meterId.toLowerCase()) || null;
}

export async function getLatest(ref: MeterRef): Promise<ReadingPayload | null> {
  const raw = await redis.get(key(ref.collectorId, ref.meterId, 'latest'));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ReadingPayload;
  } catch {
    return null;
  }
}

/** Ambil hingga `count` sample terbaru (index 0 = terbaru). */
export async function getReadings(ref: MeterRef, count = 240): Promise<ReadingPayload[]> {
  const raw = await redis.lrange(key(ref.collectorId, ref.meterId, 'readings'), 0, count - 1);
  const out: ReadingPayload[] = [];
  for (const item of raw) {
    try {
      out.push(JSON.parse(item) as ReadingPayload);
    } catch {
      /* skip item rusak */
    }
  }
  return out;
}

export async function getDeviceInfo(ref: MeterRef): Promise<DeviceInfoHash> {
  return (await redis.hgetall(key(ref.collectorId, ref.meterId, 'device_info'))) as DeviceInfoHash;
}
