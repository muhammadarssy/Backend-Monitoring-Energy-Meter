import { env } from '../config/env.js';
import {
  DatamartAggRow,
  DatamartRuntimeRow,
  queryDaily,
  queryMonthly,
  queryRuntimeSessions,
} from '../lib/datamart.js';
import { getMeta, isoWithOffset, listKnownMeters, localTimeStr } from './machineService.js';
import { parseLoadDate } from './loadService.js';

export type ReportPeriod = 'daily' | 'monthly' | 'range';

export interface ReportEnergy {
  total: number;
  wbp: number;
  lwbp: number;
}

export interface ReportRuntime {
  running_seconds: number;
  running_hours: number;
  session_count: number;
  still_running: boolean;
}

export interface ReportSession {
  meter_id: string;
  name: string;
  device_type: string;
  session_no: number;
  start_time: string | null;
  stop_time: string | null;
  running_seconds: number;
  still_running: boolean;
}

export interface ReportMachine {
  id: string;
  name: string;
  type: string;
  energy: ReportEnergy;
  runtime: ReportRuntime;
  sessions: ReportSession[];
}

export interface ReportResult {
  period: ReportPeriod;
  from: string;
  to: string;
  meter_id: string | null;
  machines: ReportMachine[];
  totals: {
    energy: ReportEnergy;
    runtime: ReportRuntime;
  };
  meta: {
    period_label: string;
    timezone: string;
    data_source: string;
    server_time_local: string;
  };
}

interface CalDate {
  year: number;
  month: number;
  day: number;
}

const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun',
  'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des',
];
const MONTH_NAMES_FULL = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember',
];

const pad = (n: number) => n.toString().padStart(2, '0');
const roundEnergy = (n: number) => Math.round(n * 1000) / 1000;
const roundHours = (seconds: number) => Math.round((seconds / 3600) * 1000) / 1000;
const dateStr = (d: CalDate) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

function wibMidnightUtc(d: CalDate): Date {
  const localMidnightUtcMs = Date.UTC(d.year, d.month - 1, d.day, 0, 0, 0);
  return new Date(localMidnightUtcMs - env.tzOffsetMinutes * 60000);
}

function addCalendarDays(d: CalDate, days: number): CalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDayLabel(d: CalDate): string {
  const wd = new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
  return `${DAY_NAMES[wd]}, ${d.day} ${MONTH_NAMES[d.month - 1]} ${d.year}`;
}

function emptyEnergy(): ReportEnergy {
  return { total: 0, wbp: 0, lwbp: 0 };
}

function emptyRuntime(): ReportRuntime {
  return { running_seconds: 0, running_hours: 0, session_count: 0, still_running: false };
}

function sumEnergy(rows: DatamartAggRow[]): ReportEnergy {
  let wbp = 0;
  let lwbp = 0;
  for (const r of rows) {
    wbp += r.wbp;
    lwbp += r.lwbp;
  }
  wbp = roundEnergy(wbp);
  lwbp = roundEnergy(lwbp);
  return { total: roundEnergy(wbp + lwbp), wbp, lwbp };
}

function sumRuntime(rows: DatamartRuntimeRow[]): ReportRuntime {
  let seconds = 0;
  let stillRunning = false;
  for (const r of rows) {
    seconds += r.running_seconds;
    if (r.still_running) stillRunning = true;
  }
  return {
    running_seconds: roundEnergy(seconds),
    running_hours: roundHours(seconds),
    session_count: rows.length,
    still_running: stillRunning,
  };
}

function mapSessions(rows: DatamartRuntimeRow[]): ReportSession[] {
  return rows.map((r) => ({
    meter_id: r.meter_id,
    name: getMeta(r.meter_id).name,
    device_type: r.device_type,
    session_no: r.session_no,
    start_time: r.start_time ? isoWithOffset(r.start_time) : null,
    stop_time: r.stop_time ? isoWithOffset(r.stop_time) : null,
    running_seconds: roundEnergy(r.running_seconds),
    still_running: r.still_running,
  }));
}

function resolveMeterIds(requested: string[] | null): string[] {
  const known = listKnownMeters();
  const knownSet = new Set(known.map((m) => m.id));
  if (requested && requested.length > 0) {
    return requested.filter((id) => knownSet.has(id));
  }
  return known.map((m) => m.id);
}

export const REPORT_PERIODS: ReportPeriod[] = ['daily', 'monthly', 'range'];
export const MAX_RANGE_DAYS = 366;

export function parseReportDate(raw: string | undefined): CalDate | null {
  if (!raw) return null;
  return parseLoadDate(raw);
}

export async function getReport(opts: {
  period: ReportPeriod;
  date: CalDate | null;
  from: CalDate | null;
  to: CalDate | null;
  meterId: string | null;
  meterIds: string[] | null;
}): Promise<ReportResult> {
  const { period } = opts;
  let from: CalDate;
  let toInclusive: CalDate;
  let dataSource: string;
  let periodLabel: string;

  if (period === 'daily') {
    if (!opts.date) throw new Error('Parameter date wajib untuk period=daily');
    from = opts.date;
    toInclusive = opts.date;
    dataSource = 'datamart.meter_agg_daily';
    periodLabel = formatDayLabel(from);
  } else if (period === 'monthly') {
    if (!opts.date) throw new Error('Parameter date wajib untuk period=monthly');
    from = { year: opts.date.year, month: opts.date.month, day: 1 };
    toInclusive = {
      year: opts.date.year,
      month: opts.date.month,
      day: daysInMonth(opts.date.year, opts.date.month),
    };
    dataSource = 'datamart.meter_agg_monthly';
    periodLabel = `${MONTH_NAMES_FULL[from.month - 1]} ${from.year}`;
  } else {
    if (!opts.from || !opts.to) throw new Error('Parameter from dan to wajib untuk period=range');
    from = opts.from;
    toInclusive = opts.to;
    const span =
      (Date.UTC(toInclusive.year, toInclusive.month - 1, toInclusive.day) -
        Date.UTC(from.year, from.month - 1, from.day)) /
      86400000;
    if (span < 0) throw new Error('Parameter from harus sebelum atau sama dengan to');
    if (span > MAX_RANGE_DAYS) {
      throw new Error(`Rentang maksimal ${MAX_RANGE_DAYS} hari`);
    }
    dataSource = 'datamart.meter_agg_daily';
    periodLabel =
      dateStr(from) === dateStr(toInclusive)
        ? formatDayLabel(from)
        : `${from.day} ${MONTH_NAMES[from.month - 1]} ${from.year} – ${toInclusive.day} ${MONTH_NAMES[toInclusive.month - 1]} ${toInclusive.year}`;
  }

  const windowFrom = wibMidnightUtc(from);
  const windowTo = wibMidnightUtc(addCalendarDays(toInclusive, 1));

  let requested = opts.meterIds;
  if (opts.meterId) requested = [opts.meterId];
  const ids = resolveMeterIds(requested);

  const energyQuery = period === 'monthly' ? queryMonthly : queryDaily;
  const [energyRows, runtimeRows] = await Promise.all([
    ids.length ? energyQuery(windowFrom, windowTo, ids) : Promise.resolve([] as DatamartAggRow[]),
    ids.length ? queryRuntimeSessions(windowFrom, windowTo, ids) : Promise.resolve([] as DatamartRuntimeRow[]),
  ]);

  const energyByMeter = new Map<string, DatamartAggRow[]>();
  for (const row of energyRows) {
    const list = energyByMeter.get(row.meter_id);
    if (list) list.push(row);
    else energyByMeter.set(row.meter_id, [row]);
  }
  const runtimeByMeter = new Map<string, DatamartRuntimeRow[]>();
  for (const row of runtimeRows) {
    const list = runtimeByMeter.get(row.meter_id);
    if (list) list.push(row);
    else runtimeByMeter.set(row.meter_id, [row]);
  }

  const machines: ReportMachine[] = ids.map((id) => {
    const meta = getMeta(id);
    const rtRows = runtimeByMeter.get(id) || [];
    return {
      id,
      name: meta.name,
      type: meta.type,
      energy: sumEnergy(energyByMeter.get(id) || []),
      runtime: sumRuntime(rtRows),
      sessions: mapSessions(rtRows),
    };
  });

  const totalsEnergy = machines.reduce(
    (acc, m) => {
      acc.total += m.energy.total;
      acc.wbp += m.energy.wbp;
      acc.lwbp += m.energy.lwbp;
      return acc;
    },
    emptyEnergy(),
  );
  const totalsRuntime = machines.reduce(
    (acc, m) => {
      acc.running_seconds += m.runtime.running_seconds;
      acc.session_count += m.runtime.session_count;
      if (m.runtime.still_running) acc.still_running = true;
      return acc;
    },
    emptyRuntime(),
  );
  totalsRuntime.running_hours = roundHours(totalsRuntime.running_seconds);
  totalsEnergy.total = roundEnergy(totalsEnergy.total);
  totalsEnergy.wbp = roundEnergy(totalsEnergy.wbp);
  totalsEnergy.lwbp = roundEnergy(totalsEnergy.lwbp);

  return {
    period,
    from: dateStr(from),
    to: dateStr(toInclusive),
    meter_id: opts.meterId,
    machines,
    totals: {
      energy: totalsEnergy,
      runtime: {
        ...totalsRuntime,
        running_seconds: roundEnergy(totalsRuntime.running_seconds),
      },
    },
    meta: {
      period_label: periodLabel,
      timezone: env.tzLabel,
      data_source: dataSource,
      server_time_local: localTimeStr(),
    },
  };
}
