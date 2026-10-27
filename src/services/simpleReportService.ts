import { env } from '../config/env.js';
import { datamartPool } from '../lib/datamart.js';
import { getMeta, localTimeStr } from './machineService.js';

/**
 * Mesin injeksi yang masuk laporan sederhana.
 * Utilitas (utils_id*) sengaja tidak ada di daftar ini.
 * Hari jalan = tanggal yang kWh hariannya (WBP+LWBP) mencapai minDailyKwh.
 * Di bawah ambang itu hari dan jamnya tidak masuk sewa.
 * Sewa = hari jalan × tarif harian. IDR/h = sewa ÷ jam hari yang dihitung.
 */
const INJECTION_MACHINES = [
  { id: 'meter_id1', code: 'MA1600_1', dailyRate: 875_000 },
  { id: 'meter_id2', code: 'MA1600_2', dailyRate: 875_000 },
  { id: 'meter_id3', code: 'MA1600_3', dailyRate: 875_000 },
  { id: 'meter_id4', code: 'MA3200', dailyRate: 1_340_000 },
] as const;

const METER_IDS = INJECTION_MACHINES.map((m) => m.id);

/** kWh harian minimum agar tanggal itu dihitung hari jalan. */
export const DEFAULT_MIN_DAILY_KWH = 30;

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

interface BucketAgg {
  wbp: number;
  lwbp: number;
  seconds: number;
  operatingDays: number;
}

interface EnergyRow {
  period_start: string;
  meter_id: string;
  wbp: number;
  lwbp: number;
}

interface DailyRuntimeRow {
  day: string;
  meter_id: string;
  running_seconds: number;
}

interface DailyEnergyRow {
  day: string;
  meter_id: string;
  kwh: number;
}

export interface SimpleMachineRow {
  id: string;
  name: string;
  code: string;
  hours: number;
  days: number;
  daily_rate: number;
  idr_per_hour: number;
  rental_total: number;
  running_seconds: number;
  wbp: number;
  lwbp: number;
}

export interface SimplePeriodBlock {
  label: string;
  from: string;
  to: string;
  iso_year?: number;
  week?: number;
  year?: number;
  month?: number;
  machines: SimpleMachineRow[];
  rental_total: number;
  energy: { wbp: number; lwbp: number; total: number };
}

export interface SimpleReportResult {
  machines: Array<{ id: string; name: string; code: string; daily_rate: number }>;
  weeks: SimplePeriodBlock[];
  months: SimplePeriodBlock[];
  meta: {
    timezone: string;
    week_system: string;
    data_source: string;
    server_time_local: string;
    min_daily_kwh: number;
  };
}

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function emptyAgg(): BucketAgg {
  return { wbp: 0, lwbp: 0, seconds: 0, operatingDays: 0 };
}

/** Senin dari tanggal kalender lokal (YYYY-MM-DD). */
function mondayOf(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
  return addDays(ymd, 1 - dow);
}

function monthStart(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

function monthEnd(ymd: string): string {
  const [y, m] = ymd.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(m)}-${p(last)}`;
}

/** Senin ISO → nomor minggu ISO 8601 (Senin–Minggu), sama dengan epochconverter. */
function isoWeekOfMonday(ymd: string): { isoYear: number; week: number } {
  const [y, m, d] = ymd.split('-').map(Number);
  const monday = new Date(Date.UTC(y, m - 1, d));
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow + 1);
  const week = Math.round((monday.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
  return { isoYear, week };
}

function machineRow(
  spec: (typeof INJECTION_MACHINES)[number],
  agg: BucketAgg,
): SimpleMachineRow {
  const hours = round3(agg.seconds / 3600);
  const days = agg.operatingDays;
  const rental = days * spec.dailyRate;
  const idrPerHour = hours > 0 ? rental / hours : 0;
  return {
    id: spec.id,
    name: getMeta(spec.id).name,
    code: spec.code,
    hours,
    days,
    daily_rate: spec.dailyRate,
    idr_per_hour: round2(idrPerHour),
    rental_total: rental,
    running_seconds: Math.round(agg.seconds),
    wbp: round3(agg.wbp),
    lwbp: round3(agg.lwbp),
  };
}

function buildBlock(
  byMeter: Map<string, BucketAgg>,
  label: string,
  from: string,
  to: string,
  extra: Partial<SimplePeriodBlock>,
): SimplePeriodBlock | null {
  const active = [...byMeter.values()].some((a) => a.seconds > 0 || a.wbp > 0 || a.lwbp > 0);
  if (!active) return null;

  const machines = INJECTION_MACHINES.map((spec) => machineRow(spec, byMeter.get(spec.id) || emptyAgg()));
  const energy = machines.reduce(
    (acc, m) => {
      acc.wbp += m.wbp;
      acc.lwbp += m.lwbp;
      return acc;
    },
    { wbp: 0, lwbp: 0, total: 0 },
  );
  energy.wbp = round3(energy.wbp);
  energy.lwbp = round3(energy.lwbp);
  energy.total = round3(energy.wbp + energy.lwbp);
  const rental = round2(machines.reduce((sum, m) => sum + m.rental_total, 0));

  return {
    label,
    from,
    to,
    ...extra,
    machines,
    rental_total: rental,
    energy,
  };
}

function slot(periods: Map<string, Map<string, BucketAgg>>, start: string, meterId: string) {
  let meters = periods.get(start);
  if (!meters) {
    meters = new Map();
    periods.set(start, meters);
  }
  let agg = meters.get(meterId);
  if (!agg) {
    agg = emptyAgg();
    meters.set(meterId, agg);
  }
  return agg;
}

function indexEnergy(energyRows: EnergyRow[]) {
  const periods = new Map<string, Map<string, BucketAgg>>();
  for (const row of energyRows) {
    const agg = slot(periods, row.period_start, row.meter_id);
    agg.wbp += row.wbp;
    agg.lwbp += row.lwbp;
  }
  return periods;
}

interface OperatingDay {
  day: string;
  meterId: string;
  kwh: number;
  seconds: number;
}

/** Hari jalan hanya yang kWh-nya mencapai ambang. Jam di bawah ambang ikut dibuang. */
function qualifyingDays(energy: DailyEnergyRow[], runtime: DailyRuntimeRow[], minKwh: number): OperatingDay[] {
  const byKey = new Map<string, OperatingDay>();
  const touch = (day: string, meterId: string) => {
    const key = `${day}|${meterId}`;
    let row = byKey.get(key);
    if (!row) {
      row = { day, meterId, kwh: 0, seconds: 0 };
      byKey.set(key, row);
    }
    return row;
  };
  for (const row of energy) touch(row.day, row.meter_id).kwh += row.kwh;
  for (const row of runtime) touch(row.day, row.meter_id).seconds += row.running_seconds;
  return [...byKey.values()].filter((row) => row.kwh >= minKwh);
}

function applyOperatingDays(
  periods: Map<string, Map<string, BucketAgg>>,
  days: OperatingDay[],
  periodOf: (day: string) => string,
) {
  for (const row of days) {
    const agg = slot(periods, periodOf(row.day), row.meterId);
    agg.seconds += row.seconds;
    agg.operatingDays += 1;
  }
}

async function queryEnergy(grain: 'week' | 'month'): Promise<EnergyRow[]> {
  const tz = env.datamartTimezone;
  const periodExpr =
    grain === 'week'
      ? `to_char((date_trunc('week', bucket_start AT TIME ZONE $1))::date, 'YYYY-MM-DD')`
      : `to_char((date_trunc('month', bucket_start AT TIME ZONE $1))::date, 'YYYY-MM-DD')`;

  const sql = `
    SELECT ${periodExpr} AS period_start,
           meter_id,
           SUM(COALESCE(impep_wbp_kwh, 0)) AS wbp,
           SUM(COALESCE(impep_lwbp_kwh, 0)) AS lwbp
      FROM datamart.meter_agg_daily
     WHERE meter_id = ANY($2::text[])
     GROUP BY period_start, meter_id
  `;
  const res = await datamartPool.query(sql, [tz, METER_IDS]);
  return res.rows.map((r) => ({
    period_start: String(r.period_start),
    meter_id: String(r.meter_id),
    wbp: num(r.wbp),
    lwbp: num(r.lwbp),
  }));
}

async function queryDailyEnergy(): Promise<DailyEnergyRow[]> {
  const tz = env.datamartTimezone;
  const sql = `
    SELECT to_char((bucket_start AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
           meter_id,
           SUM(COALESCE(impep_wbp_kwh, 0) + COALESCE(impep_lwbp_kwh, 0)) AS kwh
      FROM datamart.meter_agg_daily
     WHERE meter_id = ANY($2::text[])
     GROUP BY day, meter_id
  `;
  const res = await datamartPool.query(sql, [tz, METER_IDS]);
  return res.rows.map((r) => ({
    day: String(r.day),
    meter_id: String(r.meter_id),
    kwh: num(r.kwh),
  }));
}

async function queryDailyRuntime(): Promise<DailyRuntimeRow[]> {
  const tz = env.datamartTimezone;
  const sql = `
    SELECT to_char((bucket_start AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS day,
           meter_id,
           SUM(COALESCE(running_seconds, 0)) AS running_seconds
      FROM datamart.meter_runtime_session
     WHERE meter_id = ANY($2::text[])
     GROUP BY day, meter_id
  `;
  const res = await datamartPool.query(sql, [tz, METER_IDS]);
  return res.rows.map((r) => ({
    day: String(r.day),
    meter_id: String(r.meter_id),
    running_seconds: num(r.running_seconds),
  }));
}

export async function getSimpleReport(minDailyKwh = DEFAULT_MIN_DAILY_KWH): Promise<SimpleReportResult> {
  const [weekEnergy, monthEnergy, dailyEnergy, dailyRuntime] = await Promise.all([
    queryEnergy('week'),
    queryEnergy('month'),
    queryDailyEnergy(),
    queryDailyRuntime(),
  ]);
  const operating = qualifyingDays(dailyEnergy, dailyRuntime, minDailyKwh);

  const weekPeriods = indexEnergy(weekEnergy);
  const monthPeriods = indexEnergy(monthEnergy);
  applyOperatingDays(weekPeriods, operating, mondayOf);
  applyOperatingDays(monthPeriods, operating, monthStart);

  const weekStarts = [...weekPeriods.keys()].sort();
  const weekMeta = new Map(weekStarts.map((start) => [start, isoWeekOfMonday(start)]));
  const showYear = new Set([...weekMeta.values()].map((w) => w.isoYear)).size > 1;

  const weeks: SimplePeriodBlock[] = [];
  for (const start of weekStarts) {
    const { isoYear, week } = weekMeta.get(start) || isoWeekOfMonday(start);
    const label = showYear ? `Week# ${week}, ${isoYear}` : `Week# ${week}`;
    const block = buildBlock(
      weekPeriods.get(start) || new Map(),
      label,
      start,
      addDays(start, 6),
      { iso_year: isoYear, week },
    );
    if (block) weeks.push(block);
  }

  const months: SimplePeriodBlock[] = [];
  for (const start of [...monthPeriods.keys()].sort()) {
    const year = Number(start.slice(0, 4));
    const month = Number(start.slice(5, 7));
    const block = buildBlock(
      monthPeriods.get(start) || new Map(),
      `${MONTH_NAMES[month - 1] || start} ${year}`,
      start,
      monthEnd(start),
      { year, month },
    );
    if (block) months.push(block);
  }

  return {
    machines: INJECTION_MACHINES.map((m) => ({
      id: m.id,
      name: getMeta(m.id).name,
      code: m.code,
      daily_rate: m.dailyRate,
    })),
    weeks,
    months,
    meta: {
      timezone: env.datamartTimezone,
      week_system: 'ISO 8601 (Senin–Minggu)',
      data_source: 'datamart.meter_agg_daily + datamart.meter_runtime_session',
      server_time_local: localTimeStr(),
      min_daily_kwh: minDailyKwh,
    },
  };
}
