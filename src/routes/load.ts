import { Router, Request, Response } from 'express';
import {
  LOAD_GROUPS,
  LOAD_PERIODS,
  LoadGroup,
  LoadPeriod,
  getLoadSeries,
  parseLoadDate,
} from '../services/loadService.js';
import { localTimeStr } from '../services/machineService.js';
import { env } from '../config/env.js';

const router = Router();

function parseMeterIds(raw: unknown): string[] | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * GET /load
 *   ?period=daily|weekly|monthly|yearly
 *   &date=YYYY-MM-DD
 *   &meter_id=meter_01        (opsional; abaikan jika group=per_meter)
 *   &meter_ids=id1,id2        (opsional; filter mesin)
 *   &group=total|per_meter    (default total)
 *
 * Sumber: schema datamart (pool DATAMART_DB_URL), bukan meter_readings collector.
 *   daily/weekly  → datamart.meter_agg_1h
 *   monthly       → datamart.meter_agg_daily
 *   yearly        → datamart.meter_agg_monthly
 *   runtime       → datamart.meter_runtime_session (semua period)
 */
router.get('/load', async (req: Request, res: Response) => {
  try {
    const periodRaw = String(req.query.period || 'daily').toLowerCase();
    if (!LOAD_PERIODS.includes(periodRaw as LoadPeriod)) {
      return res.status(400).json({
        success: false,
        error: `Parameter period tidak valid. Pilihan: ${LOAD_PERIODS.join(', ')}`,
      });
    }
    const period = periodRaw as LoadPeriod;

    const dateRaw =
      (req.query.date as string | undefined) ||
      (() => {
        const now = new Date();
        const shifted = new Date(now.getTime() + env.tzOffsetMinutes * 60000);
        const y = shifted.getUTCFullYear();
        const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
        const d = String(shifted.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
      })();
    const date = parseLoadDate(dateRaw);
    if (!date) {
      return res.status(400).json({
        success: false,
        error: 'Parameter date harus YYYY-MM-DD yang valid',
      });
    }

    const groupRaw = String(req.query.group || 'total').toLowerCase();
    if (!LOAD_GROUPS.includes(groupRaw as LoadGroup)) {
      return res.status(400).json({
        success: false,
        error: `Parameter group tidak valid. Pilihan: ${LOAD_GROUPS.join(', ')}`,
      });
    }
    const group = groupRaw as LoadGroup;

    const meterIdRaw = (req.query.meter_id as string | undefined)?.trim() || null;
    const meterId = meterIdRaw && meterIdRaw !== 'all' && meterIdRaw !== 'each' ? meterIdRaw : null;
    const meterIds = parseMeterIds(req.query.meter_ids);

    const data = await getLoadSeries({
      period,
      date,
      group,
      meterId,
      meterIds,
    });

    res.json({
      success: true,
      load: {
        endpoint: 'GET /api/dashboard/load',
        data: {
          ...data,
          meta: {
            ...data.meta,
            server_time_local: localTimeStr(),
          },
        },
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message || 'Internal Server Error',
    });
  }
});

export default router;
