import { Router, Request, Response } from 'express';
import {
  MAX_RANGE_DAYS,
  REPORT_PERIODS,
  ReportPeriod,
  getReport,
  parseReportDate,
} from '../services/reportService.js';

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
 * GET /report
 *   ?period=daily|monthly|range
 *   &date=YYYY-MM-DD          (daily / monthly)
 *   &from=YYYY-MM-DD&to=YYYY-MM-DD  (range, inklusif)
 *   &meter_id=meter_id1       (opsional)
 *   &meter_ids=id1,id2        (opsional; Unknown diabaikan)
 *
 * Energi + jam operasi dari datamart. Biaya dihitung di klien (tarif).
 */
router.get('/report', async (req: Request, res: Response) => {
  try {
    const periodRaw = String(req.query.period || 'daily').toLowerCase();
    if (!REPORT_PERIODS.includes(periodRaw as ReportPeriod)) {
      return res.status(400).json({
        success: false,
        error: `Parameter period tidak valid. Pilihan: ${REPORT_PERIODS.join(', ')}`,
      });
    }
    const period = periodRaw as ReportPeriod;

    const date = parseReportDate(req.query.date as string | undefined);
    const from = parseReportDate(req.query.from as string | undefined);
    const to = parseReportDate(req.query.to as string | undefined);

    if (period === 'daily' || period === 'monthly') {
      if (!date) {
        return res.status(400).json({
          success: false,
          error: 'Parameter date harus YYYY-MM-DD yang valid',
        });
      }
    } else if (!from || !to) {
      return res.status(400).json({
        success: false,
        error: `Parameter from dan to harus YYYY-MM-DD (maks ${MAX_RANGE_DAYS} hari)`,
      });
    }

    const meterIdRaw = (req.query.meter_id as string | undefined)?.trim() || null;
    const meterId = meterIdRaw && meterIdRaw !== 'all' ? meterIdRaw : null;
    const meterIds = parseMeterIds(req.query.meter_ids);

    const data = await getReport({
      period,
      date,
      from,
      to,
      meterId,
      meterIds,
    });

    res.json({
      success: true,
      report: {
        endpoint: 'GET /api/dashboard/report',
        data,
      },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    const badRequest =
      /wajib|tidak valid|harus|maksimal|sebelum/i.test(message);
    res.status(badRequest ? 400 : 500).json({
      success: false,
      error: message,
    });
  }
});

export default router;
