import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../lib/db.js';

export interface BillingTenant {
  name: string;
  company: string;
  location: string;
}

export interface BillingRate {
  meter_id: string;
  daily_rate: number;
}

export interface BillingSessionMark {
  meter_id: string;
  session_no: number;
  start_time: string;
  included: boolean;
  sewa: number;
  note: string;
}

export interface MasterTenant {
  id: number;
  name: string;
  company: string;
  location: string;
  rates: BillingRate[];
}

export interface BillingRecord {
  period_from: string;
  saved: boolean;
  tenant_id: number | null;
  tenant: BillingTenant;
  rates: BillingRate[];
  sessions: BillingSessionMark[];
}

const PERIOD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_TEXT = 200;
const MAX_NOTE = 500;

export function periodFromInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = PERIOD_RE.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-01`;
}

let schemaReady: Promise<void> | null = null;

function ensureBillingSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = pool
      .query(readFileSync(join(process.cwd(), 'billing.sql'), 'utf8'))
      .then(() => undefined)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

function emptyTenant(): BillingTenant {
  return { name: '', company: '', location: '' };
}

function parseTenantId(raw: unknown): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function parseRates(raw: Array<Partial<BillingRate>> | undefined): BillingRate[] {
  const rateMap = new Map<string, number>();
  for (const rate of raw ?? []) {
    const meterId = String(rate.meter_id ?? '').trim();
    const daily = Number(rate.daily_rate);
    if (!meterId) throw new Error('meter_id tarif wajib diisi');
    if (!Number.isFinite(daily) || daily < 0) {
      throw new Error(`Biaya sewa untuk ${meterId} tidak valid`);
    }
    rateMap.set(meterId, daily);
  }
  return [...rateMap.entries()].map(([meter_id, daily_rate]) => ({ meter_id, daily_rate }));
}

function tenantFromRow(row: {
  name?: unknown;
  company?: unknown;
  location?: unknown;
}): BillingTenant {
  return {
    name: cleanText(row.name, 'Nama penyewa', MAX_TEXT),
    company: cleanText(row.company, 'Perusahaan', MAX_TEXT),
    location: cleanText(row.location, 'Lokasi', MAX_TEXT),
  };
}

function groupTenants(rows: Array<Record<string, unknown>>): MasterTenant[] {
  const map = new Map<number, MasterTenant>();
  for (const row of rows) {
    const id = Number(row.id);
    let tenant = map.get(id);
    if (!tenant) {
      tenant = {
        id,
        name: String(row.name ?? ''),
        company: String(row.company ?? ''),
        location: String(row.location ?? ''),
        rates: [],
      };
      map.set(id, tenant);
    }
    if (row.meter_id) {
      tenant.rates.push({
        meter_id: String(row.meter_id),
        daily_rate: Number(row.daily_rate),
      });
    }
  }
  return [...map.values()];
}

const TENANT_SQL = `
  SELECT t.id, t.name, t.company, t.location, r.meter_id, r.daily_rate
    FROM billing.tenant t
    LEFT JOIN billing.tenant_machine_rate r ON r.tenant_id = t.id
`;

export async function listTenants(): Promise<MasterTenant[]> {
  await ensureBillingSchema();
  const result = await pool.query(`${TENANT_SQL} ORDER BY t.name, t.id, r.meter_id`);
  return groupTenants(result.rows);
}

export async function getTenant(id: number): Promise<MasterTenant | null> {
  await ensureBillingSchema();
  const result = await pool.query(`${TENANT_SQL} WHERE t.id = $1 ORDER BY r.meter_id`, [id]);
  return groupTenants(result.rows)[0] ?? null;
}

async function writeTenantRates(
  client: PoolClient,
  tenantId: number,
  rates: BillingRate[],
): Promise<void> {
  await client.query('DELETE FROM billing.tenant_machine_rate WHERE tenant_id = $1', [tenantId]);
  if (rates.length === 0) return;
  await client.query(
    `INSERT INTO billing.tenant_machine_rate (tenant_id, meter_id, daily_rate)
     SELECT $1, meter_id, daily_rate
       FROM unnest($2::text[], $3::numeric[]) AS t(meter_id, daily_rate)`,
    [tenantId, rates.map((r) => r.meter_id), rates.map((r) => r.daily_rate)],
  );
}

export async function createTenant(body: {
  name?: unknown;
  company?: unknown;
  location?: unknown;
  rates?: Array<Partial<BillingRate>>;
}): Promise<MasterTenant> {
  await ensureBillingSchema();
  const tenant = tenantFromRow(body);
  if (!tenant.name || !tenant.company || !tenant.location) {
    throw new Error('Nama, perusahaan, dan lokasi penyewa wajib diisi');
  }
  const rates = parseRates(body.rates);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO billing.tenant (name, company, location)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [tenant.name, tenant.company, tenant.location],
    );
    const id = Number(inserted.rows[0].id);
    await writeTenantRates(client, id, rates);
    await client.query('COMMIT');
    const created = await getTenant(id);
    if (!created) throw new Error('Penyewa tidak ditemukan');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateTenant(
  rawId: unknown,
  body: {
    name?: unknown;
    company?: unknown;
    location?: unknown;
    rates?: Array<Partial<BillingRate>>;
  },
): Promise<MasterTenant> {
  await ensureBillingSchema();
  const id = parseTenantId(rawId);
  if (!id) throw new Error('id penyewa tidak valid');
  const tenant = tenantFromRow(body);
  if (!tenant.name || !tenant.company || !tenant.location) {
    throw new Error('Nama, perusahaan, dan lokasi penyewa wajib diisi');
  }
  const rates = parseRates(body.rates);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE billing.tenant
          SET name = $2, company = $3, location = $4, updated_at = now()
        WHERE id = $1`,
      [id, tenant.name, tenant.company, tenant.location],
    );
    if (updated.rowCount === 0) throw new Error('Penyewa tidak ditemukan');
    await writeTenantRates(client, id, rates);
    await client.query('COMMIT');
    const saved = await getTenant(id);
    if (!saved) throw new Error('Penyewa tidak ditemukan');
    return saved;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteTenant(rawId: unknown): Promise<void> {
  await ensureBillingSchema();
  const id = parseTenantId(rawId);
  if (!id) throw new Error('id penyewa tidak valid');
  const result = await pool.query('DELETE FROM billing.tenant WHERE id = $1', [id]);
  if (result.rowCount === 0) throw new Error('Penyewa tidak ditemukan');
}

function cleanText(value: unknown, label: string, max: number): string {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new Error(`${label} maksimal ${max} karakter`);
  return text;
}

export async function getBilling(periodFrom: string): Promise<BillingRecord> {
  await ensureBillingSchema();
  const [invoice, rates, sessions] = await Promise.all([
    pool.query(
      `SELECT tenant_id, tenant_name, tenant_company, tenant_location
         FROM billing.invoice
        WHERE period_from = $1::date`,
      [periodFrom],
    ),
    pool.query(
      `SELECT meter_id, daily_rate
         FROM billing.invoice_machine_rate
        WHERE period_from = $1::date
        ORDER BY meter_id`,
      [periodFrom],
    ),
    pool.query(
      `SELECT meter_id, session_no, start_time, included, sewa, note
         FROM billing.invoice_session_mark
        WHERE period_from = $1::date
        ORDER BY start_time, meter_id, session_no`,
      [periodFrom],
    ),
  ]);

  const row = invoice.rows[0];
  return {
    period_from: periodFrom,
    saved: Boolean(row),
    tenant_id: row?.tenant_id ? Number(row.tenant_id) : null,
    tenant: row
      ? {
          name: String(row.tenant_name ?? ''),
          company: String(row.tenant_company ?? ''),
          location: String(row.tenant_location ?? ''),
        }
      : emptyTenant(),
    rates: rates.rows.map((r) => ({
      meter_id: String(r.meter_id),
      daily_rate: Number(r.daily_rate),
    })),
    sessions: sessions.rows.map((r) => ({
      meter_id: String(r.meter_id),
      session_no: Number(r.session_no),
      start_time: new Date(r.start_time).toISOString(),
      included: Boolean(r.included),
      sewa: Number(r.sewa),
      note: String(r.note ?? ''),
    })),
  };
}

export async function saveBilling(body: {
  period_from: unknown;
  tenant_id?: unknown;
  rates?: Array<Partial<BillingRate>>;
  sessions?: Array<Partial<BillingSessionMark>>;
}): Promise<BillingRecord> {
  await ensureBillingSchema();
  const periodFrom = periodFromInput(body.period_from);
  if (!periodFrom) throw new Error('period_from harus YYYY-MM-DD yang valid');

  const tenantId = parseTenantId(body.tenant_id);
  if (!tenantId) throw new Error('Penyewa wajib dipilih');
  const master = await getTenant(tenantId);
  if (!master) throw new Error('Penyewa tidak ditemukan');
  const tenant: BillingTenant = {
    name: master.name,
    company: master.company,
    location: master.location,
  };
  if (!tenant.name || !tenant.company || !tenant.location) {
    throw new Error('Nama, perusahaan, dan lokasi penyewa wajib diisi');
  }

  const requestedMeters = [
    ...new Set((body.rates ?? []).map((rate) => String(rate.meter_id ?? '').trim()).filter(Boolean)),
  ];
  const masterRates = new Map(master.rates.map((rate) => [rate.meter_id, rate.daily_rate]));
  const rates: BillingRate[] = [];
  for (const meterId of requestedMeters) {
    const daily = masterRates.get(meterId);
    if (daily === undefined) {
      throw new Error(`Harga sewa harian untuk ${meterId} belum diatur`);
    }
    rates.push({ meter_id: meterId, daily_rate: daily });
  }

  const sessionMap = new Map<string, BillingSessionMark>();
  for (const row of body.sessions ?? []) {
    const meterId = String(row.meter_id ?? '').trim();
    const sessionNo = Number(row.session_no);
    const start = new Date(String(row.start_time ?? ''));
    const sewa = Number(row.sewa);
    if (!meterId || !Number.isInteger(sessionNo)) {
      throw new Error('Identitas sesi tidak lengkap');
    }
    if (Number.isNaN(start.getTime())) throw new Error('Waktu mulai sesi tidak valid');
    if (!Number.isFinite(sewa) || sewa < 0) {
      throw new Error(`Nilai sewa sesi ${meterId} tidak valid`);
    }
    const mark: BillingSessionMark = {
      meter_id: meterId,
      session_no: sessionNo,
      start_time: start.toISOString(),
      included: Boolean(row.included),
      sewa,
      note: cleanText(row.note, 'Keterangan', MAX_NOTE),
    };
    sessionMap.set(`${meterId}|${sessionNo}|${start.getTime()}`, mark);
  }

  const sessions = [...sessionMap.values()];
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO billing.invoice
         (period_from, tenant_id, tenant_name, tenant_company, tenant_location, updated_at)
       VALUES ($1::date, $2, $3, $4, $5, now())
       ON CONFLICT (period_from) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         tenant_name = EXCLUDED.tenant_name,
         tenant_company = EXCLUDED.tenant_company,
         tenant_location = EXCLUDED.tenant_location,
         updated_at = now()`,
      [periodFrom, tenantId, tenant.name, tenant.company, tenant.location],
    );
    if (rates.length > 0) {
      await client.query(
        `INSERT INTO billing.invoice_machine_rate (period_from, meter_id, daily_rate)
         SELECT $1::date, meter_id, daily_rate
           FROM unnest($2::text[], $3::numeric[]) AS t(meter_id, daily_rate)
         ON CONFLICT (period_from, meter_id) DO UPDATE SET
           daily_rate = EXCLUDED.daily_rate`,
        [periodFrom, rates.map((r) => r.meter_id), rates.map((r) => r.daily_rate)],
      );
    }
    if (sessions.length > 0) {
      await client.query(
        `INSERT INTO billing.invoice_session_mark
           (period_from, meter_id, session_no, start_time, included, sewa, note)
         SELECT $1::date, meter_id, session_no, start_time, included, sewa, note
           FROM unnest($2::text[], $3::int[], $4::timestamptz[], $5::boolean[], $6::numeric[], $7::text[])
             AS t(meter_id, session_no, start_time, included, sewa, note)
         ON CONFLICT (period_from, meter_id, session_no, start_time) DO UPDATE SET
           included = EXCLUDED.included,
           sewa = EXCLUDED.sewa,
           note = EXCLUDED.note`,
        [
          periodFrom,
          sessions.map((s) => s.meter_id),
          sessions.map((s) => s.session_no),
          sessions.map((s) => s.start_time),
          sessions.map((s) => s.included),
          sessions.map((s) => s.sewa),
          sessions.map((s) => s.note),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getBilling(periodFrom);
}

export interface MachineDayNote {
  meter_id: string;
  note_date: string;
  note: string;
}

export interface MachineDaySewa {
  meter_id: string;
  sewa_date: string;
  sewa: number;
}

function calendarDateInput(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = PERIOD_RE.exec(raw.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

export async function listDayNotes(
  fromRaw: unknown,
  toRaw: unknown,
  meterRaw: unknown,
): Promise<MachineDayNote[]> {
  await ensureBillingSchema();
  const from = calendarDateInput(fromRaw);
  const to = calendarDateInput(toRaw);
  if (!from || !to || from > to) throw new Error('Rentang tanggal tidak valid');
  const meterId = meterRaw === undefined || meterRaw === null || String(meterRaw).trim() === ''
    ? null
    : cleanText(meterRaw, 'meter_id', 64);
  if (meterId === '') throw new Error('meter_id tidak valid');
  const result = await pool.query(
    `SELECT meter_id, to_char(note_date, 'YYYY-MM-DD') AS note_date, note
       FROM billing.machine_day_note
      WHERE note_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR meter_id = $3)
      ORDER BY note_date, meter_id`,
    [from, to, meterId],
  );
  return result.rows.map((row) => ({
    meter_id: String(row.meter_id),
    note_date: String(row.note_date),
    note: String(row.note ?? ''),
  }));
}

export async function saveDayNote(body: {
  meter_id?: unknown;
  note_date?: unknown;
  note?: unknown;
}): Promise<MachineDayNote | null> {
  await ensureBillingSchema();
  const meterId = cleanText(body.meter_id, 'meter_id', 64);
  if (!meterId) throw new Error('meter_id wajib diisi');
  const noteDate = calendarDateInput(body.note_date);
  if (!noteDate) throw new Error('note_date harus YYYY-MM-DD yang valid');
  const note = cleanText(body.note, 'Keterangan', MAX_NOTE);
  if (!note) {
    await pool.query(
      'DELETE FROM billing.machine_day_note WHERE meter_id = $1 AND note_date = $2::date',
      [meterId, noteDate],
    );
    return null;
  }
  const result = await pool.query(
    `INSERT INTO billing.machine_day_note (meter_id, note_date, note)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (meter_id, note_date) DO UPDATE SET
       note = EXCLUDED.note,
       updated_at = now()
     RETURNING meter_id, to_char(note_date, 'YYYY-MM-DD') AS note_date, note`,
    [meterId, noteDate, note],
  );
  const row = result.rows[0];
  return {
    meter_id: String(row.meter_id),
    note_date: String(row.note_date),
    note: String(row.note),
  };
}

export async function listDaySewa(
  fromRaw: unknown,
  toRaw: unknown,
  meterRaw: unknown,
): Promise<MachineDaySewa[]> {
  await ensureBillingSchema();
  const from = calendarDateInput(fromRaw);
  const to = calendarDateInput(toRaw);
  if (!from || !to || from > to) throw new Error('Rentang tanggal tidak valid');
  const meterId = meterRaw === undefined || meterRaw === null || String(meterRaw).trim() === ''
    ? null
    : cleanText(meterRaw, 'meter_id', 64);
  if (meterId === '') throw new Error('meter_id tidak valid');
  const result = await pool.query(
    `SELECT meter_id, to_char(sewa_date, 'YYYY-MM-DD') AS sewa_date, sewa
       FROM billing.machine_day_sewa
      WHERE sewa_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR meter_id = $3)
      ORDER BY sewa_date, meter_id`,
    [from, to, meterId],
  );
  return result.rows.map((row) => ({
    meter_id: String(row.meter_id),
    sewa_date: String(row.sewa_date),
    sewa: Number(row.sewa),
  }));
}

export async function saveDaySewa(body: {
  meter_id?: unknown;
  sewa_date?: unknown;
  sewa?: unknown;
}): Promise<MachineDaySewa | null> {
  await ensureBillingSchema();
  const meterId = cleanText(body.meter_id, 'meter_id', 64);
  if (!meterId) throw new Error('meter_id wajib diisi');
  const sewaDate = calendarDateInput(body.sewa_date);
  if (!sewaDate) throw new Error('sewa_date harus YYYY-MM-DD yang valid');
  const sewa = Number(body.sewa);
  if (sewa === 1 || body.sewa === '' || body.sewa === null || body.sewa === undefined) {
    await pool.query(
      'DELETE FROM billing.machine_day_sewa WHERE meter_id = $1 AND sewa_date = $2::date',
      [meterId, sewaDate],
    );
    return null;
  }
  if (sewa !== 0.5) throw new Error('Nilai sewa harus 1 atau 0,5');
  const result = await pool.query(
    `INSERT INTO billing.machine_day_sewa (meter_id, sewa_date, sewa)
     VALUES ($1, $2::date, $3)
     ON CONFLICT (meter_id, sewa_date) DO UPDATE SET
       sewa = EXCLUDED.sewa,
       updated_at = now()
     RETURNING meter_id, to_char(sewa_date, 'YYYY-MM-DD') AS sewa_date, sewa`,
    [meterId, sewaDate, sewa],
  );
  const row = result.rows[0];
  return {
    meter_id: String(row.meter_id),
    sewa_date: String(row.sewa_date),
    sewa: Number(row.sewa),
  };
}
