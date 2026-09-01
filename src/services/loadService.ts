import { env } from '../config/env.js';
import {
  DatamartAggRow,
  queryDaily,
  queryHourly,
  queryMonthly,
} from '../lib/datamart.js';
import { getMeta, isoWithOffset } from './machineService.js';

export type LoadPeriod = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type LoadGroup = 'total' | 'per_meter';

export interface LoadBucket {
  i: number;
  label: string;
  timestamp: string;
  wbp: number;
  lwbp: number;
  energy: number;
}

export interface LoadTotals {
  energy: number;
  wbp: number;
  lwbp: number;
}

export interface LoadMachineSeries {
  id: string;
  name: string;
  buckets: LoadBucket[];
  totals: LoadTotals;
}

export interface LoadResult {
  period: LoadPeriod;
  date: string;
  meter_id: string | null;
  group: LoadGroup;
  buckets: LoadBucket[];
  totals: LoadTotals;
  machines: LoadMachineSeries[] | null;
  meta: {
    period_label: string;
    resolution: string;
    timezone: string;
    data_source: string;
    day_tick_labels: string[] | null;
    server_time_local?: string;
  };
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

interface CalDate {
  year: number;
  month: number;
  day: number;
}

function parseDateParam(raw: string): CalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Midnight WIB as UTC Date. */
function wibMidnightUtc(d: CalDate): Date {
  const localMidnightUtcMs = Date.UTC(d.year, d.month - 1, d.day, 0, 0, 0);
  return new Date(localMidnightUtcMs - env.tzOffsetMinutes * 60000);
}

function addCalendarDays(d: CalDate, days: number): CalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Senin awal minggu ISO yang memuat tanggal kalender. */
function startOfMonday(d: CalDate): CalDate {
  const utc = new Date(Date.UTC(d.year, d.month - 1, d.day));
  const dow = utc.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  return addCalendarDays(d, diff);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function localPartsFromUtc(date: Date) {
  const shifted = new Date(date.getTime() + env.tzOffsetMinutes * 60000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
  };
}

function bucketKey(date: Date, grain: 'hour' | 'day' | 'month'): string {
  const p = localPartsFromUtc(date);
  if (grain === 'hour') return `${p.year}-${p.month}-${p.day}-${p.hour}`;
  if (grain === 'day') return `${p.year}-${p.month}-${p.day}`;
  return `${p.year}-${p.month}`;
}

interface Slot {
  i: number;
  time: Date;
  label: string;
  extra?: { dayLabel?: string };
}

function formatPeriodLabel(period: LoadPeriod, ref: CalDate): string {
  if (period === 'daily') {
    const wd = new Date(Date.UTC(ref.year, ref.month - 1, ref.day)).getUTCDay();
    return `${DAY_NAMES[wd]}, ${ref.day} ${MONTH_NAMES[ref.month - 1]} ${ref.year}`;
  }
  if (period === 'weekly') {
    const start = startOfMonday(ref);
    const end = addCalendarDays(start, 6);
    const sameMonth = start.month === end.month;
    const startStr = sameMonth
      ? `${start.day}`
      : `${start.day} ${MONTH_NAMES[start.month - 1]}`;
    return `${startStr}–${end.day} ${MONTH_NAMES[end.month - 1]} ${end.year}`;
  }
  if (period === 'monthly') {
    return `${MONTH_NAMES_FULL[ref.month - 1]} ${ref.year}`;
  }
  return `${ref.year}`;
}

function buildSlots(period: LoadPeriod, ref: CalDate): {
  from: Date;
  to: Date;
  slots: Slot[];
  grain: 'hour' | 'day' | 'month';
  dataSource: string;
  resolution: string;
  dayTickLabels: string[] | null;
} {
  if (period === 'daily') {
    const from = wibMidnightUtc(ref);
    const to = wibMidnightUtc(addCalendarDays(ref, 1));
    const slots: Slot[] = [];
    for (let h = 0; h < 24; h += 1) {
      slots.push({
        i: h,
        time: new Date(from.getTime() + h * 3600000),
        label: `${pad(h)}:00`,
      });
    }
    return {
      from,
      to,
      slots,
      grain: 'hour',
      dataSource: 'datamart.meter_agg_1h',
      resolution: 'Per jam',
      dayTickLabels: null,
    };
  }

  if (period === 'weekly') {
    const monday = startOfMonday(ref);
    const from = wibMidnightUtc(monday);
    const to = wibMidnightUtc(addCalendarDays(monday, 7));
    const slots: Slot[] = [];
    const dayTickLabels: string[] = [];
    for (let d = 0; d < 7; d += 1) {
      const day = addCalendarDays(monday, d);
      const wd = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
      const dayName = DAY_NAMES[wd];
      for (let h = 0; h < 24; h += 1) {
        const label = `${dayName} ${pad(h)}:00`;
        if (h === 0) dayTickLabels.push(label);
        slots.push({
          i: d * 24 + h,
          time: new Date(from.getTime() + (d * 24 + h) * 3600000),
          label,
          extra: { dayLabel: dayName },
        });
      }
    }
    return {
      from,
      to,
      slots,
      grain: 'hour',
      dataSource: 'datamart.meter_agg_1h',
      resolution: 'Per jam',
      dayTickLabels,
    };
  }

  if (period === 'monthly') {
    const days = daysInMonth(ref.year, ref.month);
    const from = wibMidnightUtc({ year: ref.year, month: ref.month, day: 1 });
    const nextMonth = ref.month === 12
      ? { year: ref.year + 1, month: 1, day: 1 }
      : { year: ref.year, month: ref.month + 1, day: 1 };
    const to = wibMidnightUtc(nextMonth);
    const slots: Slot[] = [];
    for (let d = 1; d <= days; d += 1) {
      slots.push({
        i: d,
        time: wibMidnightUtc({ year: ref.year, month: ref.month, day: d }),
        label: String(d),
      });
    }
    return {
      from,
      to,
      slots,
      grain: 'day',
      dataSource: 'datamart.meter_agg_daily',
      resolution: 'Per hari',
      dayTickLabels: null,
    };
  }

  const from = wibMidnightUtc({ year: ref.year, month: 1, day: 1 });
  const to = wibMidnightUtc({ year: ref.year + 1, month: 1, day: 1 });
  const slots: Slot[] = [];
  for (let m = 0; m < 12; m += 1) {
    slots.push({
      i: m,
      time: wibMidnightUtc({ year: ref.year, month: m + 1, day: 1 }),
      label: MONTH_NAMES[m],
    });
  }
  return {
    from,
    to,
    slots,
    grain: 'month',
    dataSource: 'datamart.meter_agg_monthly',
    resolution: 'Per bulan',
    dayTickLabels: null,
  };
}

function indexRows(rows: DatamartAggRow[], grain: 'hour' | 'day' | 'month') {
  const map = new Map<string, { wbp: number; lwbp: number }>();
  for (const r of rows) {
    const key = `${r.meter_id}|${bucketKey(r.bucket_start, grain)}`;
    const prev = map.get(key);
    if (prev) {
      prev.wbp += r.wbp;
      prev.lwbp += r.lwbp;
    } else {
      map.set(key, { wbp: r.wbp, lwbp: r.lwbp });
    }
  }
  return map;
}

function fillBuckets(
  slots: Slot[],
  grain: 'hour' | 'day' | 'month',
  indexed: Map<string, { wbp: number; lwbp: number }>,
  meterIds: string[] | null,
  singleMeter?: string
): LoadBucket[] {
  return slots.map((s) => {
    let wbp = 0;
    let lwbp = 0;
    const timeKey = bucketKey(s.time, grain);
    if (singleMeter) {
      const hit = indexed.get(`${singleMeter}|${timeKey}`);
      if (hit) {
        wbp = hit.wbp;
        lwbp = hit.lwbp;
      }
    } else if (meterIds) {
      for (const id of meterIds) {
        const hit = indexed.get(`${id}|${timeKey}`);
        if (hit) {
          wbp += hit.wbp;
          lwbp += hit.lwbp;
        }
      }
    } else {
      for (const [key, hit] of indexed) {
        if (key.endsWith(`|${timeKey}`)) {
          wbp += hit.wbp;
          lwbp += hit.lwbp;
        }
      }
    }
    wbp = roundEnergy(wbp);
    lwbp = roundEnergy(lwbp);
    return {
      i: s.i,
      label: s.label,
      timestamp: isoWithOffset(s.time),
      wbp,
      lwbp,
      energy: roundEnergy(wbp + lwbp),
    };
  });
}

function totalsOf(buckets: LoadBucket[]): LoadTotals {
  return buckets.reduce(
    (acc, b) => {
      acc.energy += b.energy;
      acc.wbp += b.wbp;
      acc.lwbp += b.lwbp;
      return acc;
    },
    { energy: 0, wbp: 0, lwbp: 0 }
  );
}

function uniqueMeterIds(rows: DatamartAggRow[]): string[] {
  return [...new Set(rows.map((r) => r.meter_id))];
}

export function parseLoadDate(raw: string | undefined): CalDate | null {
  if (!raw) return null;
  return parseDateParam(raw);
}

export async function getLoadSeries(opts: {
  period: LoadPeriod;
  date: CalDate;
  group: LoadGroup;
  meterId: string | null;
  meterIds: string[] | null;
}): Promise<LoadResult> {
  const { period, date, group } = opts;
  const { from, to, slots, grain, dataSource, resolution, dayTickLabels } = buildSlots(
    period,
    date
  );

  let filterIds: string[] | null = opts.meterIds;
  if (opts.meterId && opts.meterId !== 'all') {
    filterIds = [opts.meterId];
  }

  const rows =
    grain === 'hour'
      ? await queryHourly(from, to, filterIds)
      : grain === 'day'
        ? await queryDaily(from, to, filterIds)
        : await queryMonthly(from, to, filterIds);

  const indexed = indexRows(rows, grain);
  const dateStr = `${date.year}-${pad(date.month)}-${pad(date.day)}`;

  const meta = {
    period_label: formatPeriodLabel(period, date),
    resolution,
    timezone: env.tzLabel,
    data_source: dataSource,
    day_tick_labels: dayTickLabels,
  };

  if (group === 'per_meter') {
    const ids = filterIds && filterIds.length > 0 ? filterIds : uniqueMeterIds(rows);
    const machines: LoadMachineSeries[] = ids.map((id) => {
      const buckets = fillBuckets(slots, grain, indexed, null, id);
      const totals = totalsOf(buckets);
      return { id, name: getMeta(id).name, buckets, totals };
    });
    const totals = machines.reduce(
      (acc, m) => {
        acc.energy += m.totals.energy;
        acc.wbp += m.totals.wbp;
        acc.lwbp += m.totals.lwbp;
        return acc;
      },
      { energy: 0, wbp: 0, lwbp: 0 }
    );
    return {
      period,
      date: dateStr,
      meter_id: null,
      group,
      buckets: fillBuckets(slots, grain, indexed, ids.length ? ids : null),
      totals: {
        energy: roundEnergy(totals.energy),
        wbp: roundEnergy(totals.wbp),
        lwbp: roundEnergy(totals.lwbp),
      },
      machines,
      meta,
    };
  }

  const buckets = fillBuckets(
    slots,
    grain,
    indexed,
    filterIds,
    opts.meterId && opts.meterId !== 'all' ? opts.meterId : undefined
  );
  const totals = totalsOf(buckets);
  return {
    period,
    date: dateStr,
    meter_id: opts.meterId && opts.meterId !== 'all' ? opts.meterId : 'all',
    group,
    buckets,
    totals: {
      energy: roundEnergy(totals.energy),
      wbp: roundEnergy(totals.wbp),
      lwbp: roundEnergy(totals.lwbp),
    },
    machines: null,
    meta,
  };
}

export const LOAD_PERIODS: LoadPeriod[] = ['daily', 'weekly', 'monthly', 'yearly'];
export const LOAD_GROUPS: LoadGroup[] = ['total', 'per_meter'];
