import { ReadingPayload } from '../lib/redisClient.js';

type PhaseV = 'Ua' | 'Ub' | 'Uc';
type PhaseI = 'Ia' | 'Ib' | 'Ic';

const rawVal = (payload: ReadingPayload | null, field: string): number | null => {
  if (!payload) return null;
  const v = payload.values?.[field];
  return v === null || v === undefined || Number.isNaN(v) ? null : Number(v);
};

/** CT/PT ratio dari sample Redis (fallback 1 jika register tidak ada). */
export function ratioCoeffs(payload: ReadingPayload | null): { urAt: number; irAt: number } {
  return {
    urAt: rawVal(payload, 'UrAt') ?? 1,
    irAt: rawVal(payload, 'IrAt') ?? 1,
  };
}

/**
 * Tegangan fase: Ux * (UrAt * 0.1) * 0.1
 */
export function scaledVoltageV(payload: ReadingPayload | null, phase: PhaseV): number | null {
  const raw = rawVal(payload, phase);
  if (raw === null) return null;
  const { urAt } = ratioCoeffs(payload);
  return raw * (urAt * 0.1) * 0.1;
}

/**
 * Arus fase: Ix * IrAt * 0.001
 */
export function scaledCurrentA(payload: ReadingPayload | null, phase: PhaseI): number | null {
  const raw = rawVal(payload, phase);
  if (raw === null) return null;
  const { irAt } = ratioCoeffs(payload);
  return raw * irAt * 0.001;
}

/**
 * Energi kumulatif: Ep * UrAt * IrAt (Ep = ImpEp di Redis)
 */
export function scaledEnergyKwh(payload: ReadingPayload | null): number {
  const ep = rawVal(payload, 'ImpEp');
  if (ep === null) return 0;
  const { urAt, irAt } = ratioCoeffs(payload);
  return ep * urAt * irAt;
}

/**
 * Daya aktif dari register Pt (W) → kW, dengan ratio CT/PT:
 * Pt * (UrAt * 0.1) * (IrAt * 0.1)
 */
export function scaledPowerKw(payload: ReadingPayload | null): number {
  const pt = rawVal(payload, 'Pt');
  if (pt === null) return 0;
  const { urAt, irAt } = ratioCoeffs(payload);
  return (pt * (urAt * 0.1) * (irAt * 0.1)) / 1000;
}

export function scaledPhaseVoltage(payload: ReadingPayload | null) {
  return {
    u: scaledVoltageV(payload, 'Ua') ?? 0,
    v: scaledVoltageV(payload, 'Ub') ?? 0,
    w: scaledVoltageV(payload, 'Uc') ?? 0,
  };
}

export function scaledPhaseCurrent(payload: ReadingPayload | null) {
  return {
    u: scaledCurrentA(payload, 'Ia') ?? 0,
    v: scaledCurrentA(payload, 'Ib') ?? 0,
    w: scaledCurrentA(payload, 'Ic') ?? 0,
  };
}
