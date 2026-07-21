import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Lapisan PostgreSQL untuk data historis & metrics turunan.
 * Tabel: meter_readings, production_sessions, production_cycles (lihat schema.sql collector).
 * Catatan: nama kolom disimpan lowercase oleh PostgreSQL (mis. Pt -> pt, ImpEp -> impep).
 */
export const pool = new pg.Pool({
  connectionString: env.dbUrl,
  max: env.dbPoolMax,
  connectionTimeoutMillis: env.dbConnectionTimeoutMs,
  idleTimeoutMillis: env.dbIdleTimeoutMs,
});

pool.on('error', (err) => {
  console.error(`[pg] ${err.message}`);
});

export interface CycleStats {
  avgCycleSec: number | null;
  runTimeHours: number;
  cycleCountToday: number;
}

/** Statistik agregat per meter: rata-rata durasi cycle, jam operasi, jumlah cycle hari ini. */
export async function getCycleStats(meterId: string, todayStartUtc: Date): Promise<CycleStats> {
  const [avgRes, runRes, cntRes] = await Promise.all([
    pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (end_time - start_time))) AS avg_sec
         FROM production_cycles
        WHERE meter_id = $1 AND end_time IS NOT NULL`,
      [meterId]
    ),
    pool.query(
      `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time))), 0) / 3600.0 AS hours
         FROM production_sessions
        WHERE meter_id = $1`,
      [meterId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM production_cycles
        WHERE meter_id = $1 AND start_time >= $2`,
      [meterId, todayStartUtc]
    ),
  ]);

  const avgSec = avgRes.rows[0]?.avg_sec;
  return {
    avgCycleSec: avgSec === null || avgSec === undefined ? null : Number(avgSec),
    runTimeHours: Number(runRes.rows[0]?.hours ?? 0),
    cycleCountToday: Number(cntRes.rows[0]?.cnt ?? 0),
  };
}

export interface DailyMetric {
  date: string;
  count: number;
  energyKwh: number;
}

/**
 * Statistik seluruh meter dalam satu query. Dipakai summary agar jumlah query
 * tidak bertambah mengikuti jumlah meter.
 */
export async function getCycleStatsBulk(
  meterIds: string[],
  todayStartUtc: Date
): Promise<Map<string, CycleStats>> {
  if (meterIds.length === 0) return new Map();

  const result = await pool.query(
    `WITH requested AS (
       SELECT unnest($1::text[]) AS meter_id
     ),
     cycle_stats AS (
       SELECT meter_id,
              AVG(EXTRACT(EPOCH FROM (end_time - start_time)))
                FILTER (WHERE end_time IS NOT NULL) AS avg_sec,
              COUNT(*) FILTER (WHERE start_time >= $2)::int AS cycle_count_today
         FROM production_cycles
        WHERE meter_id = ANY($1::text[])
        GROUP BY meter_id
     ),
     session_stats AS (
       SELECT meter_id,
              COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(end_time, now()) - start_time))), 0)
                / 3600.0 AS hours
         FROM production_sessions
        WHERE meter_id = ANY($1::text[])
        GROUP BY meter_id
     )
     SELECT r.meter_id, c.avg_sec,
            COALESCE(s.hours, 0) AS hours,
            COALESCE(c.cycle_count_today, 0)::int AS cycle_count_today
       FROM requested r
       LEFT JOIN cycle_stats c USING (meter_id)
       LEFT JOIN session_stats s USING (meter_id)`,
    [meterIds, todayStartUtc]
  );

  return new Map(
    result.rows.map((row) => [
      String(row.meter_id),
      {
        avgCycleSec: row.avg_sec === null || row.avg_sec === undefined ? null : Number(row.avg_sec),
        runTimeHours: Number(row.hours ?? 0),
        cycleCountToday: Number(row.cycle_count_today ?? 0),
      },
    ])
  );
}

/**
 * Heatmap semua meter terpilih dalam satu query, bukan delapan query per meter.
 */
export async function getDailyMetricsBulk(
  meterIds: string[],
  days: { date: string; startUtc: Date; endUtc: Date }[]
): Promise<Map<string, DailyMetric[]>> {
  const output = new Map<string, DailyMetric[]>();
  for (const meterId of meterIds) output.set(meterId, []);
  if (meterIds.length === 0 || days.length === 0) return output;

  const result = await pool.query(
    `WITH requested AS (
       SELECT unnest($1::text[]) AS meter_id
     ),
     requested_days AS (
       SELECT *
         FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[])
              AS d(date, start_utc, end_utc)
     ),
     cycle_counts AS (
       SELECT c.meter_id, d.date, COUNT(*)::int AS count
         FROM production_cycles c
         JOIN requested_days d
           ON c.start_time >= d.start_utc AND c.start_time < d.end_utc
        WHERE c.meter_id = ANY($1::text[])
        GROUP BY c.meter_id, d.date
     ),
     energy_totals AS (
       SELECT m.meter_id, d.date, MAX(m.impep) - MIN(m.impep) AS energy
         FROM meter_readings m
         JOIN requested_days d
           ON m.time >= d.start_utc AND m.time < d.end_utc
        WHERE m.meter_id = ANY($1::text[])
        GROUP BY m.meter_id, d.date
     )
     SELECT r.meter_id, d.date,
            COALESCE(c.count, 0)::int AS count,
            COALESCE(e.energy, 0) AS energy
       FROM requested r
       CROSS JOIN requested_days d
       LEFT JOIN cycle_counts c ON c.meter_id = r.meter_id AND c.date = d.date
       LEFT JOIN energy_totals e ON e.meter_id = r.meter_id AND e.date = d.date
      ORDER BY r.meter_id, d.start_utc`,
    [
      meterIds,
      days.map((day) => day.date),
      days.map((day) => day.startUtc),
      days.map((day) => day.endUtc),
    ]
  );

  for (const row of result.rows) {
    const meterId = String(row.meter_id);
    const energy = Number(row.energy ?? 0);
    output.get(meterId)?.push({
      date: String(row.date),
      count: Number(row.count ?? 0),
      energyKwh: Math.max(0, energy),
    });
  }
  return output;
}

/**
 * Heatmap 7 hari: jumlah cycle & energi (kWh) per hari (zona waktu sesuai TZ_OFFSET_MINUTES).
 * `days` adalah batas hari [start,end) dalam UTC, dihitung di service.
 */
export async function getDailyMetrics(
  meterId: string,
  days: { date: string; startUtc: Date; endUtc: Date }[]
): Promise<DailyMetric[]> {
  // Hitung jumlah cycle per hari dalam satu query.
  const weekStart = days[0]?.startUtc;
  const cyclesRes = await pool.query(
    `SELECT start_time
       FROM production_cycles
      WHERE meter_id = $1 AND start_time >= $2`,
    [meterId, weekStart]
  );
  const cycleTimes: Date[] = cyclesRes.rows.map((r) => new Date(r.start_time));

  // Energi harian: selisih akumulasi ImpEp dalam rentang hari (best-effort per hari).
  const out: DailyMetric[] = [];
  for (const d of days) {
    const count = cycleTimes.filter((t) => t >= d.startUtc && t < d.endUtc).length;
    const eRes = await pool.query(
      `SELECT MAX(impep) - MIN(impep) AS energy
         FROM meter_readings
        WHERE meter_id = $1 AND time >= $2 AND time < $3`,
      [meterId, d.startUtc, d.endUtc]
    );
    const energy = eRes.rows[0]?.energy;
    out.push({
      date: d.date,
      count,
      energyKwh: energy === null || energy === undefined ? 0 : Math.max(0, Number(energy)),
    });
  }
  return out;
}

export interface PowerSample {
  time: Date;
  pt: number | null;
}

export interface CycleRow {
  cycle_id: string;
  start_time: Date;
  end_time: Date | null;
}

/** Ambil sample daya & cycle untuk power-graph dalam jendela waktu. */
export async function getPowerGraphData(
  meterId: string,
  sinceUtc: Date
): Promise<{ samples: PowerSample[]; cycles: CycleRow[] }> {
  const [sampleRes, cycleRes] = await Promise.all([
    pool.query(
      `SELECT time, pt
         FROM meter_readings
        WHERE meter_id = $1 AND time >= $2
        ORDER BY time ASC`,
      [meterId, sinceUtc]
    ),
    pool.query(
      `SELECT cycle_id, start_time, end_time
         FROM production_cycles
        WHERE meter_id = $1 AND (end_time IS NULL OR end_time >= $2)
        ORDER BY start_time ASC`,
      [meterId, sinceUtc]
    ),
  ]);

  return {
    samples: sampleRes.rows.map((r) => ({
      time: new Date(r.time),
      pt: r.pt === null ? null : Number(r.pt),
    })),
    cycles: cycleRes.rows.map((r) => ({
      cycle_id: String(r.cycle_id),
      start_time: new Date(r.start_time),
      end_time: r.end_time ? new Date(r.end_time) : null,
    })),
  };
}

export interface HistorySample {
  time: Date;
  pt: number | null;
  ua: number | null;
  ub: number | null;
  uc: number | null;
  ia: number | null;
  ib: number | null;
  ic: number | null;
}

/**
 * Ambil sample historis (power + voltage + current per fase) dalam rentang [from, to).
 * Dipakai endpoint power-history untuk membentuk seri time-series multi-metrik.
 */
export async function getReadingsHistory(
  meterId: string,
  fromUtc: Date,
  toUtc: Date
): Promise<HistorySample[]> {
  const res = await pool.query(
    `SELECT time, pt, ua, ub, uc, ia, ib, ic
       FROM meter_readings
      WHERE meter_id = $1 AND time >= $2 AND time < $3
      ORDER BY time ASC`,
    [meterId, fromUtc, toUtc]
  );
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return res.rows.map((r) => ({
    time: new Date(r.time),
    pt: num(r.pt),
    ua: num(r.ua),
    ub: num(r.ub),
    uc: num(r.uc),
    ia: num(r.ia),
    ib: num(r.ib),
    ic: num(r.ic),
  }));
}

export async function pingDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
