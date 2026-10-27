import { Router, Request, Response } from 'express';
import { DEFAULT_MIN_DAILY_KWH, getSimpleReport } from '../services/simpleReportService.js';

const router = Router();

/**
 * GET /simple-report?min_kwh=30
 * Seluruh minggu ISO dan bulan kalender untuk mesin injeksi (meter_id1–4).
 * Hari dengan kWh harian di bawah min_kwh tidak dihitung jalan.
 * Utilitas tidak ikut. Biaya listrik (IDR/kWh) dihitung di klien.
 */
function parseMinKwh(raw: unknown): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_MIN_DAILY_KWH;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

router.get('/simple-report', async (req: Request, res: Response) => {
  try {
    const minKwh = parseMinKwh(req.query.min_kwh);
    if (minKwh === null) {
      return res.status(400).json({
        success: false,
        error: 'Parameter min_kwh harus angka 0 atau lebih',
      });
    }
    const data = await getSimpleReport(minKwh);
    res.json({
      success: true,
      simple_report: {
        endpoint: 'GET /api/dashboard/simple-report',
        data,
      },
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error?.message || 'Internal Server Error',
    });
  }
});

export default router;
