import { Router, Request, Response } from 'express';
import {
  createTenant,
  deleteTenant,
  getBilling,
  listDayNotes,
  listDaySewa,
  listTenants,
  periodFromInput,
  saveBilling,
  saveDayNote,
  saveDaySewa,
  updateTenant,
} from '../services/billingService.js';

const router = Router();

function isBadRequest(message: string): boolean {
  return /wajib|tidak valid|harus|maksimal|tidak ditemukan|belum diatur/i.test(message);
}

/**
 * GET /billing?from=YYYY-MM-DD
 * Marking tagihan bulan tersebut. from dinormalisasi ke tanggal 1.
 * saved=false bila bulan itu belum pernah disimpan.
 */
router.get('/billing', async (req: Request, res: Response) => {
  try {
    const periodFrom = periodFromInput(req.query.from);
    if (!periodFrom) {
      return res.status(400).json({
        success: false,
        error: 'Parameter from harus YYYY-MM-DD yang valid',
      });
    }
    const data = await getBilling(periodFrom);
    res.json({
      success: true,
      billing: {
        endpoint: 'GET /api/dashboard/billing',
        data,
      },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({
      success: false,
      error: message,
    });
  }
});

/**
 * PUT /billing
 * Simpan penyewa yang dipilih, tarif master penyewa itu, dan sesi yang dikirim.
 * Baris bulan yang sama untuk mesin/sesi yang tidak ikut payload tidak dihapus.
 */
router.put('/billing', async (req: Request, res: Response) => {
  try {
    const data = await saveBilling(req.body ?? {});
    res.json({
      success: true,
      billing: {
        endpoint: 'PUT /api/dashboard/billing',
        data,
      },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({
      success: false,
      error: message,
    });
  }
});

/**
 * GET /billing/day-notes?from=&to=&meter_id=
 * Catatan harian. from dan to inklusif. meter_id opsional.
 */
router.get('/billing/day-notes', async (req: Request, res: Response) => {
  try {
    const data = await listDayNotes(req.query.from, req.query.to, req.query.meter_id);
    res.json({
      success: true,
      notes: { endpoint: 'GET /api/dashboard/billing/day-notes', data },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

/**
 * PUT /billing/day-notes
 * Simpan keterangan satu mesin pada satu hari. Teks kosong menghapus catatan.
 */
router.put('/billing/day-notes', async (req: Request, res: Response) => {
  try {
    const data = await saveDayNote(req.body ?? {});
    res.json({
      success: true,
      note: { endpoint: 'PUT /api/dashboard/billing/day-notes', data },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

/**
 * GET /billing/day-sewa?from=&to=&meter_id=
 * Tanda sewa harian. from dan to inklusif. meter_id opsional.
 */
router.get('/billing/day-sewa', async (req: Request, res: Response) => {
  try {
    const data = await listDaySewa(req.query.from, req.query.to, req.query.meter_id);
    res.json({
      success: true,
      sewa: { endpoint: 'GET /api/dashboard/billing/day-sewa', data },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

/**
 * PUT /billing/day-sewa
 * Simpan sewa satu mesin pada satu hari. 1 menghapus tanda (kembali ke 1 hari). 0,5 menyimpan setengah hari.
 */
router.put('/billing/day-sewa', async (req: Request, res: Response) => {
  try {
    const data = await saveDaySewa(req.body ?? {});
    res.json({
      success: true,
      sewa: { endpoint: 'PUT /api/dashboard/billing/day-sewa', data },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

router.get('/billing/tenants', async (_req: Request, res: Response) => {
  try {
    const data = await listTenants();
    res.json({
      success: true,
      tenants: { endpoint: 'GET /api/dashboard/billing/tenants', data },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

router.post('/billing/tenants', async (req: Request, res: Response) => {
  try {
    const data = await createTenant(req.body ?? {});
    res.status(201).json({
      success: true,
      tenant: { endpoint: 'POST /api/dashboard/billing/tenants', data },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

router.put('/billing/tenants/:id', async (req: Request, res: Response) => {
  try {
    const data = await updateTenant(req.params.id, req.body ?? {});
    res.json({
      success: true,
      tenant: { endpoint: 'PUT /api/dashboard/billing/tenants/:id', data },
    });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

router.delete('/billing/tenants/:id', async (req: Request, res: Response) => {
  try {
    await deleteTenant(req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    const message = error.message || 'Internal Server Error';
    res.status(isBadRequest(message) ? 400 : 500).json({ success: false, error: message });
  }
});

export default router;
