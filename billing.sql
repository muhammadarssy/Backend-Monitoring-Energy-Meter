-- Master penyewa + marking tagihan sewa.
-- Schema terpisah dari ETL. Jangan menambah kolom atau foreign key ke datamart.*
-- atau tabel collector (meter_readings, production_sessions, production_cycles).
-- Identitas sesi disalin sebagai nilai, bukan relasi ke tabel runtime.
-- Harga sewa harian milik penyewa (beda penyewa, beda tarif per mesin).

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.tenant (
    id          BIGSERIAL   PRIMARY KEY,
    name        TEXT        NOT NULL,
    company     TEXT        NOT NULL DEFAULT '',
    location    TEXT        NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing.tenant_machine_rate (
    tenant_id   BIGINT        NOT NULL REFERENCES billing.tenant (id) ON DELETE CASCADE,
    meter_id    TEXT          NOT NULL,
    daily_rate  NUMERIC(14,2) NOT NULL,
    PRIMARY KEY (tenant_id, meter_id)
);

CREATE TABLE IF NOT EXISTS billing.invoice (
    period_from      DATE        PRIMARY KEY,
    tenant_id        BIGINT      REFERENCES billing.tenant (id) ON DELETE SET NULL,
    tenant_name      TEXT        NOT NULL DEFAULT '',
    tenant_company   TEXT        NOT NULL DEFAULT '',
    tenant_location  TEXT        NOT NULL DEFAULT '',
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE billing.invoice
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT REFERENCES billing.tenant (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS billing.invoice_machine_rate (
    period_from  DATE          NOT NULL REFERENCES billing.invoice (period_from) ON DELETE CASCADE,
    meter_id     TEXT          NOT NULL,
    daily_rate   NUMERIC(14,2) NOT NULL,
    PRIMARY KEY (period_from, meter_id)
);

CREATE TABLE IF NOT EXISTS billing.invoice_session_mark (
    period_from  DATE          NOT NULL REFERENCES billing.invoice (period_from) ON DELETE CASCADE,
    meter_id     TEXT          NOT NULL,
    session_no   INTEGER       NOT NULL,
    start_time   TIMESTAMPTZ   NOT NULL,
    included     BOOLEAN       NOT NULL DEFAULT TRUE,
    sewa         NUMERIC(10,2) NOT NULL DEFAULT 0,
    note         TEXT          NOT NULL DEFAULT '',
    PRIMARY KEY (period_from, meter_id, session_no, start_time)
);

-- Catatan harian per mesin. Diisi dari menu Load, ditampilkan saat cetak report.
CREATE TABLE IF NOT EXISTS billing.machine_day_note (
    meter_id    TEXT        NOT NULL,
    note_date   DATE        NOT NULL,
    note        TEXT        NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (meter_id, note_date)
);

-- Sewa harian per mesin. Hanya pengecualian yang disimpan: 0.50 = setengah hari.
-- Tidak ada baris berarti 1 hari, sama seperti default di cetak.
CREATE TABLE IF NOT EXISTS billing.machine_day_sewa (
    meter_id    TEXT          NOT NULL,
    sewa_date   DATE          NOT NULL,
    sewa        NUMERIC(4,2)  NOT NULL,
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
    PRIMARY KEY (meter_id, sewa_date)
);
