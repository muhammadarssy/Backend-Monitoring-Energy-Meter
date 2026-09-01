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
