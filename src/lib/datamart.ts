import pg from 'pg';
import { env } from '../config/env.js';

/**
 * Pool PostgreSQL khusus data mart (schema `datamart`).
 * Sengaja terpisah dari `lib/db.ts` (collector: meter_readings, cycles)
 * supaya connection string / search_path tidak tercampur.
 */
export const datamartPool = new pg.Pool({
  connectionString: env.datamartDbUrl,
  max: env.dbPoolMax,
  connectionTimeoutMillis: env.dbConnectionTimeoutMs,
  idleTimeoutMillis: env.dbIdleTimeoutMs,
});

datamartPool.on('error', (err) => {
  console.error(`[datamart] ${err.message}`);
});

export interface DatamartAggRow {
  bucket_start: Date;
  meter_id: string;
  wbp: number;
  lwbp: number;
}

export interface DatamartRuntimeRow {
  bucket_start: Date;
  meter_id: string;
  device_type: string;
  session_no: number;
  start_time: Date | null;
  stop_time: Date | null;
  running_seconds: number;
  still_running: boolean;
  sample_count: number;
  pt_max: number | null;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

function mapRows(rows: pg.QueryResult['rows']): DatamartAggRow[] {
  return rows.map((r) => ({
    bucket_start: new Date(r.bucket_start),
    meter_id: String(r.meter_id),
    wbp: num(r.wbp),
    lwbp: num(r.lwbp),
  }));
}

async function queryAgg(
  sqlAll: string,
  sqlFiltered: string,
  from: Date,
  to: Date,
  meterIds: string[] | null
): Promise<DatamartAggRow[]> {
  if (meterIds && meterIds.length === 0) return [];
  const res =
    meterIds === null
      ? await datamartPool.query(sqlAll, [from, to])
      : await datamartPool.query(sqlFiltered, [from, to, meterIds]);
  return mapRows(res.rows);
}

/** Grain 1 jam: energi dari impep_delta, pecahan WBP/LWBP via tariff_band. */
export function queryHourly(
  from: Date,
  to: Date,
  meterIds: string[] | null
): Promise<DatamartAggRow[]> {
  const select = `
    SELECT bucket_start, meter_id,
           SUM(CASE WHEN tariff_band = 'WBP' THEN COALESCE(impep_delta, 0) ELSE 0 END) AS wbp,
           SUM(CASE WHEN tariff_band = 'LWBP' THEN COALESCE(impep_delta, 0) ELSE 0 END) AS lwbp
      FROM datamart.meter_agg_1h
     WHERE bucket_start >= $1 AND bucket_start < $2`;
  return queryAgg(
    `${select} GROUP BY bucket_start, meter_id ORDER BY bucket_start, meter_id`,
    `${select} AND meter_id = ANY($3::text[]) GROUP BY bucket_start, meter_id ORDER BY bucket_start, meter_id`,
    from,
    to,
    meterIds
  );
}

/** Grain harian WIB: impep_wbp_kwh / impep_lwbp_kwh. */
export function queryDaily(
  from: Date,
  to: Date,
  meterIds: string[] | null
): Promise<DatamartAggRow[]> {
  const select = `
    SELECT bucket_start, meter_id,
           SUM(COALESCE(impep_wbp_kwh, 0)) AS wbp,
           SUM(COALESCE(impep_lwbp_kwh, 0)) AS lwbp
      FROM datamart.meter_agg_daily
     WHERE bucket_start >= $1 AND bucket_start < $2`;
  return queryAgg(
    `${select} GROUP BY bucket_start, meter_id ORDER BY bucket_start, meter_id`,
    `${select} AND meter_id = ANY($3::text[]) GROUP BY bucket_start, meter_id ORDER BY bucket_start, meter_id`,
    from,
    to,
    meterIds
  );
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Sesi nyala harian (job runtime_daily.py). energy = 1 baris/sesi; utils = 1 baris/hari. */
export function queryRuntimeSessions(
  from: Date,
  to: Date,
  meterIds: string[] | null
): Promise<DatamartRuntimeRow[]> {
  const select = `
    SELECT bucket_start, meter_id, device_type, session_no,
           start_time, stop_time, running_seconds, still_running,
           sample_count, pt_max
      FROM datamart.meter_runtime_session
     WHERE bucket_start >= $1 AND bucket_start < $2`;
  const sqlAll = `${select} ORDER BY start_time NULLS LAST, bucket_start, session_no`;
  const sqlFiltered = `${select} AND meter_id = ANY($3::text[]) ORDER BY start_time NULLS LAST, bucket_start, session_no`;

  if (meterIds && meterIds.length === 0) return Promise.resolve([]);
  const resPromise =
    meterIds === null
      ? datamartPool.query(sqlAll, [from, to])
      : datamartPool.query(sqlFiltered, [from, to, meterIds]);

  return resPromise.then((res) =>
    res.rows.map((r) => ({
      bucket_start: new Date(r.bucket_start),
      meter_id: String(r.meter_id),
      device_type: String(r.device_type),
      session_no: Number(r.session_no) || 0,
      start_time: r.start_time ? new Date(r.start_time) : null,
      stop_time: r.stop_time ? new Date(r.stop_time) : null,
      running_seconds: num(r.running_seconds),
      still_running: Boolean(r.still_running),
      sample_count: Number(r.sample_count) || 0,
      pt_max: numOrNull(r.pt_max),
    }))
  );
}

/** Grain bulanan WIB. */
export function queryMonthly(
  from: Date,
  to: Date,
  meterIds: string[] | null
): Promise<DatamartAggRow[]> {
  const select = `
    SELECT bucket_start, meter_id,
           SUM(COALESCE(impep_wbp_kwh, 0)) AS wbp,
           SUM(COALESCE(impep_lwbp_kwh, 0)) AS lwbp
      FROM datamart.meter_agg_monthly
     WHERE bucket_start >= $1 AND bucket_start < $2`;
  return queryAgg(
    `${select} GROUP BY bucket_start, meter_id ORDER BY bucket_start, meter_id`,
    `${select} AND meter_id = ANY($3::text[]) GROUP BY bucket_start, meter_id ORDER BY bucket_start, meter_id`,
    from,
    to,
    meterIds
  );
}

export async function pingDatamart(): Promise<{ ok: boolean; schema: boolean }> {
  try {
    await datamartPool.query('SELECT 1');
    const schema = await datamartPool.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.schemata WHERE schema_name = 'datamart'
       ) AS present`
    );
    return { ok: true, schema: Boolean(schema.rows[0]?.present) };
  } catch {
    return { ok: false, schema: false };
  }
}
