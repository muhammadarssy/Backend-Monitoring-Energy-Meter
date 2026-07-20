import { Router, Request, Response } from 'express';
import { discoverMeters, findMeter, getReadings } from '../lib/redisClient.js';
import {
  HistorySample,
  getCycleStats,
  getDailyMetrics,
  getPowerGraphData,
  getReadingsHistory,
} from '../lib/db.js';
import {
  scaledPhaseVoltage,
  scaledPhaseCurrent,
  scaledPowerKw,
} from '../services/redisScaling.js';
import {
  MachineContext,
  diNumber,
  energyKwh,
  isoWithOffset,
  last7Days,
  loadMachineContext,
  localParts,
  localTimeStr,
  networkModeLabel,
  powerKw,
  todayStartUtc,
} from '../services/machineService.js';
import { env } from '../config/env.js';

const router = Router();

// ========== VALUE FORMATTING HELPERS (struktur response tidak diubah) ==========

const roundTo = (n: number, decimals: number): number =>
  Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);

interface Measured {
  value: number;
  unit: string;
}

const fmtVolt = (v: number): Measured => ({ value: Math.round(v), unit: 'V' });
const fmtAmp = (a: number): Measured => ({ value: roundTo(a, 1), unit: 'A' });
const fmtPower = (p: number): Measured => ({ value: roundTo(p, 1), unit: 'kW' });
const fmtEnergy = (kwh: number): Measured => {
  if (Math.abs(kwh) >= 1000) {
    return { value: parseFloat((kwh / 1000).toFixed(2)), unit: 'MWh' };
  }
  return { value: roundTo(kwh, 1), unit: 'kWh' };
};
const fmtHours = (h: number): Measured => ({ value: roundTo(h, 1), unit: 'hr' });
const fmtSec = (s: number): Measured => ({ value: s, unit: 'sec' });

// ========== HEATMAP HELPERS ==========

/**
 * Map 0–1 ke warna hex: 0=merah, 0.5=kuning, 1=hijau (interpolasi hue HSL 0°→120°).
 */
const heatmapColor = (normalized: number): string => {
  const t = Math.max(0, Math.min(1, normalized));
  const hue = t * 120;
  const s = 0.78;
  const l = 0.5;

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;

  let r1 = 0,
    g1 = 0,
    b1 = 0;
  if (hue < 60) {
    r1 = c;
    g1 = x;
    b1 = 0;
  } else if (hue < 120) {
    r1 = x;
    g1 = c;
    b1 = 0;
  } else {
    r1 = 0;
    g1 = c;
    b1 = x;
  }

  const toHex = (n: number) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
};

/**
 * Heatmap 7 hari dari data nyata (production_cycles + meter_readings).
 * Struktur output identik dengan mock: { date, cycle_count{value,color}, cycle_energy{value,color,unit} }.
 */
const buildHeatmap7d = (daily: { date: string; count: number; energyKwh: number }[]) => {
  const counts = daily.map((d) => d.count);
  const energies = daily.map((d) => roundTo(d.energyKwh, 2));

  const normalize = (arr: number[], v: number): number => {
    const mn = Math.min(...arr);
    const mx = Math.max(...arr);
    return mx > mn ? (v - mn) / (mx - mn) : 0.5;
  };

  const maxEnergy = energies.length ? Math.max(...energies) : 0;
  const usesMWh = maxEnergy >= 1000;
  const displayEnergy = (e: number) => (usesMWh ? roundTo(e / 1000, 3) : roundTo(e, 2));
  const energyUnit = usesMWh ? 'MWh' : 'kWh';

  return daily.map((d, idx) => ({
    date: d.date,
    cycle_count: {
      value: counts[idx],
      color: heatmapColor(normalize(counts, counts[idx])),
    },
    cycle_energy: {
      value: displayEnergy(energies[idx]),
      color: heatmapColor(normalize(energies, energies[idx])),
      unit: energyUnit,
    },
  }));
};

// ========== PHASE VALUE HELPERS ==========

/** Nilai voltage per fase dari Redis (setelah rumus CT/PT). */
const phaseVoltage = (ctx: MachineContext) => {
  if (ctx.status === 'offline') return { u: 0, v: 0, w: 0 };
  return scaledPhaseVoltage(ctx.latest);
};

const phaseCurrent = (ctx: MachineContext) => {
  if (ctx.status === 'offline') return { u: 0, v: 0, w: 0 };
  return scaledPhaseCurrent(ctx.latest);
};

const livePowerKw = (ctx: MachineContext) => (ctx.status === 'offline' ? 0 : powerKw(ctx.latest));

// 1. GET /summary
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const perPage = parseInt(req.query.per_page as string) || 2;

    const meters = await discoverMeters();
    const days = last7Days();
    const todayStart = todayStartUtc();

    const machinesData = await Promise.all(
      meters.map(async (ref) => {
        const ctx = await loadMachineContext(ref);
        const [stats, daily] = await Promise.all([
          getCycleStats(ref.meterId, todayStart),
          getDailyMetrics(ref.meterId, days),
        ]);

        const volt = phaseVoltage(ctx);
        const curr = phaseCurrent(ctx);

        return {
          id: ref.meterId,
          name: ctx.meta.name,
          status: ctx.status,
          sector: ctx.meta.sector,
          type: ctx.meta.type,
          metrics: {
            run_time_hr: fmtHours(stats.runTimeHours),
            cycle_time_sec: fmtSec(stats.avgCycleSec === null ? 0 : Math.round(stats.avgCycleSec)),
            cycle_count: { value: stats.cycleCountToday, unit: 'cycles' },
            power_kw: fmtPower(livePowerKw(ctx)),
            energy_mwh: fmtEnergy(energyKwh(ctx.latest)),
          },
          voltage_phase: {
            volt_u: fmtVolt(volt.u),
            volt_v: fmtVolt(volt.v),
            volt_w: fmtVolt(volt.w),
          },
          current_phase: {
            amp_u: fmtAmp(curr.u),
            amp_v: fmtAmp(curr.v),
            amp_w: fmtAmp(curr.w),
          },
          heatmap_7d: buildHeatmap7d(daily),
        };
      })
    );

    const total_mesin = machinesData.length;
    const mesin_aktif = machinesData.filter((m) => m.status === 'running').length;
    const energy_total_kwh =
      Math.round(machinesData.reduce((sum, m) => sum + (m.metrics.energy_mwh.unit === 'MWh' ? m.metrics.energy_mwh.value * 1000 : m.metrics.energy_mwh.value), 0) * 100) / 100;
    const total_power_kw =
      Math.round(machinesData.reduce((sum, m) => sum + m.metrics.power_kw.value, 0) * 10) / 10;

    const totalItems = machinesData.length;
    const totalPages = Math.ceil(totalItems / perPage) || 0;
    const startIndex = (page - 1) * perPage;
    const paginatedData = machinesData.slice(startIndex, startIndex + perPage);

    res.json({
      dashboard: {
        endpoint: 'GET /api/dashboard/summary',
        summary: {
          total_mesin,
          mesin_aktif,
          energy_total: fmtEnergy(energy_total_kwh),
          total_power: fmtPower(total_power_kw),
        },
        machines: {
          total_items: totalItems,
          page,
          per_page: perPage,
          total_pages: totalPages,
          data: paginatedData,
        },
        meta: {
          server_time_local: localTimeStr(),
          timezone: env.tzLabel,
          api_status: 'connected',
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

/** Titik buffer mock bila Redis readings kosong. */
const buildMockBufferPoints = (ctx: MachineContext, count = 60) => {
  const now = Date.now();
  const basePower = Math.max(0.5, livePowerKw(ctx));
  const volt = phaseVoltage(ctx);
  const curr = phaseCurrent(ctx);
  const points: {
    timestamp: string;
    power_kw: number;
    voltage: { u: number; v: number; w: number };
    current: { u: number; v: number; w: number };
  }[] = [];

  for (let i = count - 1; i >= 0; i--) {
    const t = new Date(now - i * 2000);
    const wave = Math.sin(i / 6) * (basePower * 0.12);
    points.push({
      timestamp: isoWithOffset(t),
      power_kw: roundTo(Math.max(0, basePower + wave), 2),
      voltage: {
        u: Math.round(volt.u || 400),
        v: Math.round(volt.v || 401),
        w: Math.round(volt.w || 399),
      },
      current: {
        u: roundTo(Math.max(0, (curr.u || basePower * 1.4) + wave * 0.05), 1),
        v: roundTo(Math.max(0, (curr.v || basePower * 1.4) + wave * 0.04), 1),
        w: roundTo(Math.max(0, (curr.w || basePower * 1.4) + wave * 0.06), 1),
      },
    });
  }
  return points;
};

const estimateIntervalSec = (points: { timestamp: string }[]): number => {
  if (points.length < 2) return 2;
  const a = new Date(points[0].timestamp).getTime();
  const b = new Date(points[1].timestamp).getTime();
  const sec = Math.round((b - a) / 1000);
  return sec > 0 ? sec : 2;
};

// 2a. GET /machines/:id/telemetry/buffer (harus sebelum /telemetry)
router.get('/machines/:id/telemetry/buffer', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const ref = await findMeter(id);

    if (!ref) {
      return res.status(404).json({
        success: false,
        error: `Machine with ID "${id}" not found`,
      });
    }

    const ctx = await loadMachineContext(ref);
    const readings = await getReadings(ref);
    const chronological = [...readings].reverse();

    const points =
      chronological.length > 0
        ? chronological.map((r) => {
            const volt = scaledPhaseVoltage(r);
            const curr = scaledPhaseCurrent(r);
            return {
              timestamp: isoWithOffset(new Date(r.timestamp)),
              power_kw: roundTo(scaledPowerKw(r), 2),
              voltage: {
                u: Math.round(volt.u),
                v: Math.round(volt.v),
                w: Math.round(volt.w),
              },
              current: {
                u: roundTo(curr.u, 1),
                v: roundTo(curr.v, 1),
                w: roundTo(curr.w, 1),
              },
            };
          })
        : buildMockBufferPoints(ctx);

    const interval_hint_sec = estimateIntervalSec(points);
    const last_timestamp = points.length ? points[points.length - 1].timestamp : isoWithOffset(new Date());

    res.json({
      realtime_buffer: {
        endpoint: `GET /api/dashboard/machines/${id}/telemetry/buffer`,
        data: {
          machine_id: ref.meterId,
          point_count: points.length,
          interval_hint_sec,
          last_timestamp,
          source: chronological.length > 0 ? 'redis_readings' : 'mock_generated',
          points,
        },
        meta: {
          server_time_local: localTimeStr(),
          timezone: env.tzLabel,
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

// 2. GET /machines/:id/telemetry
router.get('/machines/:id/telemetry', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const ref = await findMeter(id);

    if (!ref) {
      return res.status(404).json({
        success: false,
        error: `Machine with ID "${id}" not found`,
      });
    }

    const ctx = await loadMachineContext(ref);
    const stats = await getCycleStats(ref.meterId, todayStartUtc());

    const volt = phaseVoltage(ctx);
    const curr = phaseCurrent(ctx);
    const power = livePowerKw(ctx);

    const volt_avg = ctx.status === 'offline' ? 0 : roundTo((volt.u + volt.v + volt.w) / 3, 1);
    const curr_avg = ctx.status === 'offline' ? 0 : roundTo((curr.u + curr.v + curr.w) / 3, 1);

    const slaveId = diNumber(ctx.deviceInfo, 'slave_id_register', 0);
    const baudRate = diNumber(ctx.deviceInfo, 'baudrate_register', 0);
    const rtc = ctx.latest?.timestamp ? isoWithOffset(new Date(ctx.latest.timestamp)) : isoWithOffset(new Date());

    res.json({
      details: {
        endpoint: `GET /api/dashboard/machines/${id}/telemetry`,
        data: {
          device: {
            id: ref.meterId,
            name: ctx.meta.name,
            status: ctx.status,
            location: ctx.meta.sector,
            type: ctx.meta.type,
            slave_id: slaveId,
            baud_rate: baudRate,
            rtc,
            telemetry_pulse: ctx.status === 'offline' ? 'live_err' : 'live_ok',
          },
          realtime_telemetry: {
            current_avg_ampere: fmtAmp(curr_avg),
            voltage_avg_volt_ac: fmtVolt(volt_avg),
            active_load_power_kw: fmtPower(power),
            cumulative_energy_kwh: fmtEnergy(energyKwh(ctx.latest)),
          },
          sensor_table: {
            calibration_class: ctx.meta.calibration_class,
            parameters: [
              {
                parameter: 'Tegangan Listrik (Voltage)',
                function: 'Potensi beda gerak muatan antar fase line',
                phase_u: Math.round(volt.u),
                phase_v: Math.round(volt.v),
                phase_w: Math.round(volt.w),
                unit: 'Volt AC',
              },
              {
                parameter: 'Arus Beban Listrik (Current)',
                function: 'Laju muatan mengalir pada kumparan trafo',
                phase_u: roundTo(curr.u, 1),
                phase_v: roundTo(curr.v, 1),
                phase_w: roundTo(curr.w, 1),
                unit: 'Ampere',
              },
              {
                parameter: 'Daya Aktif Sektor',
                function: 'Daya riil termanfaatkan untuk mekanik mesin',
                phase_u: null,
                phase_v: roundTo(power, 1),
                phase_w: null,
                unit: 'Kilowatts',
              },
              {
                parameter: 'Lama Jam Kerja (Operating Hours)',
                function: 'Total durasi operasional mesin aktif kumulatif',
                phase_u: null,
                phase_v: roundTo(stats.runTimeHours, 1),
                phase_w: null,
                unit: 'Hours',
              },
            ],
          },
          meta: {
            data_source: 'Modbus RTU (collector → Redis/PostgreSQL)',
            server_time_local: localTimeStr(),
            timezone: env.tzLabel,
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

// 3. GET /machines/:id/device-info
router.get('/machines/:id/device-info', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const ref = await findMeter(id);

    if (!ref) {
      return res.status(404).json({
        success: false,
        error: `Machine with ID "${id}" not found`,
      });
    }

    const ctx = await loadMachineContext(ref);
    const slaveId = diNumber(ctx.deviceInfo, 'slave_id_register', 0);
    const baudRate = diNumber(ctx.deviceInfo, 'baudrate_register', 0);
    const netMode = networkModeLabel(ctx.deviceInfo);

    const p = localParts();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const rtcStr = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;

    res.json({
      device_info: {
        endpoint: `GET /api/dashboard/machines/${id}/device-info`,
        data: {
          device_info: {
            meter_type_label: 'DTSU666',
            modbus_data_type: 'INT16',
            summary: {
              slave_id: `${slaveId}`,
              baud_rate: { value: baudRate, unit: 'bps' },
              meter_type: 'DTSU666 (666)',
              network_mode: netMode,
              rtc: rtcStr,
            },
            registers: [
              {
                label: 'Meter Address',
                register: '0x002D',
                type: 'Int16',
                value: `${slaveId} (Slave)`,
                raw: slaveId,
                unit: '-',
                description: 'Slave ID',
              },
              {
                label: 'Baud Rate',
                register: '0x002E',
                type: 'Int16',
                value: `${baudRate} bps`,
                raw: baudRate,
                unit: 'bps',
                description: 'Communication baud rate',
              },
              {
                label: 'Meter Type',
                register: '0x000B',
                type: 'Int16',
                value: 'DTSU666 (666)',
                raw: 666,
                unit: '-',
                description: 'Meter type',
              },
              {
                label: 'Network Mode',
                register: '0x0003',
                type: 'Int16',
                value: netMode,
                raw: netMode === '3P4W' ? 0 : 1,
                unit: '-',
                description: '0 = 3P4W, 1 = 3P3W',
              },
              {
                label: 'Year',
                register: '0x0034',
                type: 'Int16',
                value: `${p.year}`,
                raw: p.year,
                unit: '-',
                description: 'RTC Year',
              },
              {
                label: 'Month',
                register: '0x0033',
                type: 'Int16',
                value: `${pad(p.month)}`,
                raw: p.month,
                unit: '-',
                description: 'RTC Month',
              },
              {
                label: 'Day',
                register: '0x0032',
                type: 'Int16',
                value: `${pad(p.day)}`,
                raw: p.day,
                unit: '-',
                description: 'RTC Day',
              },
              {
                label: 'Hour',
                register: '0x0031',
                type: 'Int16',
                value: `${pad(p.hour)}`,
                raw: p.hour,
                unit: '-',
                description: 'RTC Hour',
              },
              {
                label: 'Minute',
                register: '0x0030',
                type: 'Int16',
                value: `${pad(p.minute)}`,
                raw: p.minute,
                unit: '-',
                description: 'RTC Minute',
              },
              {
                label: 'Second',
                register: '0x002F',
                type: 'Int16',
                value: `${pad(p.second)}`,
                raw: p.second,
                unit: '-',
                description: 'RTC Second',
              },
            ],
          },
          meta: {
            note: 'Mapping register sesuai dokumentasi DTSU666',
            source: 'Modbus RTU (collector)',
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

// 4. GET /machines/:id/power-graph
router.get('/machines/:id/power-graph', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const ref = await findMeter(id);

    if (!ref) {
      return res.status(404).json({
        success: false,
        error: `Machine with ID "${id}" not found`,
      });
    }

    const now = new Date();
    const bucketMs = env.powerGraphBucketMinutes * 60000;
    const windowMs = env.powerGraphWindowHours * 3600000;
    const since = new Date(now.getTime() - windowMs);

    const { samples, cycles } = await getPowerGraphData(ref.meterId, since);

    // Bucketing sample daya jadi titik history (kW) berurutan.
    const numBuckets = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / bucketMs));
    const sums = new Array(numBuckets).fill(0);
    const counts = new Array(numBuckets).fill(0);
    for (const s of samples) {
      if (s.pt === null) continue;
      const idx = Math.floor((s.time.getTime() - since.getTime()) / bucketMs);
      if (idx < 0 || idx >= numBuckets) continue;
      sums[idx] += s.pt / 1000;
      counts[idx] += 1;
    }

    const history: { x: number; value: number; timestamp: string }[] = [];
    for (let i = 0; i < numBuckets; i++) {
      const bucketStart = new Date(since.getTime() + i * bucketMs);
      const value = counts[i] > 0 ? roundTo(sums[i] / counts[i], 1) : 0;
      history.push({
        x: i + 1,
        value,
        timestamp: isoWithOffset(bucketStart),
      });
    }

    const xOf = (t: Date): number => {
      const idx = Math.floor((t.getTime() - since.getTime()) / bucketMs);
      return Math.min(numBuckets, Math.max(1, idx + 1));
    };

    const cycle_markers = cycles.map((c, i) => {
      const x_start = xOf(c.start_time);
      const x_end = c.end_time ? xOf(c.end_time) : numBuckets;
      const ongoing = c.end_time === null;
      let peak = 0;
      for (let x = x_start; x <= x_end; x++) {
        const v = history[x - 1]?.value ?? 0;
        if (v > peak) peak = v;
      }
      return {
        cycle_id: i + 1,
        x_start,
        x_end,
        label: ongoing ? `Cycle ${i + 1} (ongoing)` : `Cycle ${i + 1}`,
        duration_sec: c.end_time
          ? Math.round((c.end_time.getTime() - c.start_time.getTime()) / 1000)
          : null,
        peak_power_kw: roundTo(peak, 1),
      };
    });

    res.json({
      device_info: {
        endpoint: `GET /api/dashboard/machines/${id}/power-graph`,
        data: {
          machine_id: ref.meterId,
          metric: 'power_kw',
          interval: 'per_cycle',
          history,
          cycle_markers,
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

// 5. GET /machines/:id/power-history
// Seri time-series historis (PostgreSQL), rentang waktu fleksibel + multi-metrik.
//   Query:
//     ?hours=24                  → rentang = [now-hours, now] (default 24, abaikan jika from/to ada)
//     ?from=ISO&to=ISO           → rentang eksplisit
//     ?bucket_minutes=5          → ukuran agregasi (default POWER_GRAPH_BUCKET_MINUTES)
//     ?metrics=power,voltage,current → metrik yang ditampilkan (default ketiganya)
const avgPhase = (a: number | null, b: number | null, c: number | null): number | null => {
  const vals = [a, b, c].filter((x): x is number => x !== null && !Number.isNaN(x));
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
};

const METRIC_DEFS: Record<
  string,
  { label: string; unit: string; decimals: number; extract: (s: HistorySample) => number | null }
> = {
  power: { label: 'Daya Total', unit: 'kW', decimals: 1, extract: (s) => (s.pt === null ? null : s.pt / 1000) },
  voltage: { label: 'Tegangan Rata-rata', unit: 'Volt', decimals: 0, extract: (s) => avgPhase(s.ua, s.ub, s.uc) },
  current: { label: 'Arus Rata-rata', unit: 'A', decimals: 1, extract: (s) => avgPhase(s.ia, s.ib, s.ic) },
};

const MAX_BUCKETS = 5000;

router.get('/machines/:id/power-history', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const ref = await findMeter(id);

    if (!ref) {
      return res.status(404).json({
        success: false,
        error: `Machine with ID "${id}" not found`,
      });
    }

    // ── Parse metrik ──────────────────────────────────────────────────────
    const metricsParam = (req.query.metrics as string | undefined)?.trim();
    const metricKeys = metricsParam
      ? metricsParam.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean)
      : ['power', 'voltage', 'current'];
    const invalid = metricKeys.filter((m) => !(m in METRIC_DEFS));
    if (invalid.length > 0) {
      return res.status(400).json({
        success: false,
        error: `Metrik tidak dikenal: ${invalid.join(', ')}. Pilihan: ${Object.keys(METRIC_DEFS).join(', ')}`,
      });
    }

    // ── Parse rentang waktu ───────────────────────────────────────────────
    const now = new Date();
    let from: Date;
    let to: Date;
    const fromParam = req.query.from as string | undefined;
    const toParam = req.query.to as string | undefined;

    if (fromParam || toParam) {
      from = fromParam ? new Date(fromParam) : new Date(now.getTime() - 24 * 3600000);
      to = toParam ? new Date(toParam) : now;
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return res.status(400).json({ success: false, error: 'Parameter from/to harus ISO 8601 yang valid' });
      }
    } else {
      const hours = parseFloat((req.query.hours as string) || '24');
      if (Number.isNaN(hours) || hours <= 0) {
        return res.status(400).json({ success: false, error: 'Parameter hours harus angka > 0' });
      }
      to = now;
      from = new Date(now.getTime() - hours * 3600000);
    }
    if (from.getTime() >= to.getTime()) {
      return res.status(400).json({ success: false, error: 'Rentang waktu tidak valid (from harus < to)' });
    }

    // ── Parse bucket ──────────────────────────────────────────────────────
    let bucketMinutes = parseFloat((req.query.bucket_minutes as string) || `${env.powerGraphBucketMinutes}`);
    if (Number.isNaN(bucketMinutes) || bucketMinutes <= 0) bucketMinutes = env.powerGraphBucketMinutes;
    const bucketMs = bucketMinutes * 60000;

    let numBuckets = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / bucketMs));
    if (numBuckets > MAX_BUCKETS) {
      return res.status(400).json({
        success: false,
        error: `Rentang/bucket menghasilkan ${numBuckets} titik (maks ${MAX_BUCKETS}). Perbesar bucket_minutes atau perkecil rentang.`,
      });
    }

    // ── Ambil & agregasi data ─────────────────────────────────────────────
    const samples = await getReadingsHistory(ref.meterId, from, to);

    const sums: Record<string, number[]> = {};
    const counts: Record<string, number[]> = {};
    for (const m of metricKeys) {
      sums[m] = new Array(numBuckets).fill(0);
      counts[m] = new Array(numBuckets).fill(0);
    }

    for (const s of samples) {
      const idx = Math.floor((s.time.getTime() - from.getTime()) / bucketMs);
      if (idx < 0 || idx >= numBuckets) continue;
      for (const m of metricKeys) {
        const v = METRIC_DEFS[m].extract(s);
        if (v === null) continue;
        sums[m][idx] += v;
        counts[m][idx] += 1;
      }
    }

    const series: Record<
      string,
      { label: string; unit: string; points: { x: number; value: number | null; timestamp: string }[] }
    > = {};
    for (const m of metricKeys) {
      const def = METRIC_DEFS[m];
      const points = [];
      for (let i = 0; i < numBuckets; i++) {
        const bucketStart = new Date(from.getTime() + i * bucketMs);
        const value = counts[m][i] > 0 ? roundTo(sums[m][i] / counts[m][i], def.decimals) : null;
        points.push({ x: i + 1, value, timestamp: isoWithOffset(bucketStart) });
      }
      series[m] = { label: def.label, unit: def.unit, points };
    }

    res.json({
      power_history: {
        endpoint: `GET /api/dashboard/machines/${id}/power-history`,
        data: {
          machine_id: ref.meterId,
          range: {
            from: isoWithOffset(from),
            to: isoWithOffset(to),
            bucket_minutes: bucketMinutes,
            bucket_count: numBuckets,
          },
          metrics: metricKeys,
          series,
          meta: {
            data_source: 'PostgreSQL (meter_readings)',
            sample_count: samples.length,
            note: 'value = null saat tidak ada sample di bucket (mesin idle/offline)',
            server_time_local: localTimeStr(),
            timezone: env.tzLabel,
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
