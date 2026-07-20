import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Lapisan PostgreSQL untuk data historis & metrics turunan.
 * Tabel: meter_readings, production_sessions, production_cycles (lihat schema.sql collector).
 * Catatan: nama kolom disimpan lowercase oleh PostgreSQL (mis. Pt -> pt, ImpEp -> impep).
 */
export const pool = new pg.Pool({ connectionString: env.dbUrl, max: 10 });

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
