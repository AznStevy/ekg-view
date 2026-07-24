export type LeadId =
  | "I"
  | "II"
  | "III"
  | "aVR"
  | "aVL"
  | "aVF"
  | "V1"
  | "V2"
  | "V3"
  | "V4"
  | "V5"
  | "V6";

const LEADS: LeadId[] = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"];

/**
 * Cardiac vector → 12-lead voltages (teaching-scale dipole).
 *
 * Coordinates (patient):
 *   +X  left  (Lead I positive)
 *   +Y  inferior (aVF positive)
 *   +Z  anterior
 *
 * Frontal leads use the hexaxial system. Precordials are Wilson-like
 * projections in the horizontal plane (X–Z).
 */

export type CardiacVector = {
  x: number;
  y: number;
  /** Anterior (+) / posterior (−). Default 0. */
  z?: number;
};

const DEG = Math.PI / 180;

/** Hexaxial angles (degrees): cos→X, sin→Y */
export const FRONTAL_LEAD_ANGLE_DEG: Record<
  "I" | "II" | "III" | "aVR" | "aVL" | "aVF",
  number
> = {
  I: 0,
  II: 60,
  III: 120,
  aVR: -150,
  aVL: -30,
  aVF: 90,
};

/**
 * Precordial angles in the horizontal plane from +X (left) toward +Z (anterior).
 * V1 right parasternal → V6 left midaxillary.
 */
export const PRECORDIAL_ANGLE_DEG: Record<"V1" | "V2" | "V3" | "V4" | "V5" | "V6", number> = {
  V1: 120,
  V2: 95,
  V3: 75,
  V4: 60,
  V5: 30,
  V6: 0,
};

function emptyLeads(): Record<LeadId, number> {
  return {
    I: 0,
    II: 0,
    III: 0,
    aVR: 0,
    aVL: 0,
    aVF: 0,
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: 0,
    V6: 0,
  };
}

/** Unit frontal projection: V · leadAxis */
export function frontalLeadGain(lead: keyof typeof FRONTAL_LEAD_ANGLE_DEG, v: CardiacVector): number {
  const a = FRONTAL_LEAD_ANGLE_DEG[lead] * DEG;
  return v.x * Math.cos(a) + v.y * Math.sin(a);
}

/** Horizontal precordial projection: mostly X–Z, slight inferior bleed */
export function precordialLeadGain(lead: keyof typeof PRECORDIAL_ANGLE_DEG, v: CardiacVector): number {
  const a = PRECORDIAL_ANGLE_DEG[lead] * DEG;
  const z = v.z ?? 0;
  return v.x * Math.cos(a) + z * Math.sin(a) + v.y * 0.12;
}

/** Instantaneous cardiac vector → consistent 12-lead voltages (amp scales the vector). */
export function projectCardiacVector(amp: number, v: CardiacVector): Record<LeadId, number> {
  const out = emptyLeads();
  const vec = { x: v.x * amp, y: v.y * amp, z: (v.z ?? 0) * amp };
  out.I = frontalLeadGain("I", vec);
  out.II = frontalLeadGain("II", vec);
  out.III = frontalLeadGain("III", vec);
  out.aVR = frontalLeadGain("aVR", vec);
  out.aVL = frontalLeadGain("aVL", vec);
  out.aVF = frontalLeadGain("aVF", vec);
  out.V1 = precordialLeadGain("V1", vec);
  out.V2 = precordialLeadGain("V2", vec);
  out.V3 = precordialLeadGain("V3", vec);
  out.V4 = precordialLeadGain("V4", vec);
  out.V5 = precordialLeadGain("V5", vec);
  out.V6 = precordialLeadGain("V6", vec);
  return out;
}

/** Build a unit-ish vector from frontal axis (°) and optional anterior fraction. */
export function vectorFromAxis(frontalDeg: number, anterior = 0.25): CardiacVector {
  const a = frontalDeg * DEG;
  return { x: Math.cos(a), y: Math.sin(a), z: anterior };
}

/**
 * Least-squares fit of (x, y) from any provided limb-lead hint weights,
 * then (z) from precordial hints — so artistic tables become a real dipole.
 */
export function fitCardiacVector(hints: Partial<Record<LeadId, number>>): CardiacVector {
  // Frontal: each lead ≈ x cos θ + y sin θ
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxb = 0;
  let syb = 0;
  let nF = 0;
  (Object.keys(FRONTAL_LEAD_ANGLE_DEG) as (keyof typeof FRONTAL_LEAD_ANGLE_DEG)[]).forEach((lead) => {
    const b = hints[lead];
    if (b == null || !Number.isFinite(b)) return;
    const a = FRONTAL_LEAD_ANGLE_DEG[lead] * DEG;
    const cx = Math.cos(a);
    const cy = Math.sin(a);
    sxx += cx * cx;
    sxy += cx * cy;
    syy += cy * cy;
    sxb += cx * b;
    syb += cy * b;
    nF++;
  });

  let x = 0;
  let y = 0;
  if (nF >= 1) {
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) > 1e-8) {
      // Solve [sxx sxy; sxy syy][x;y] = [sxb; syb]
      x = (sxb * syy - syb * sxy) / det;
      y = (syb * sxx - sxb * sxy) / det;
    } else if (hints.I != null) {
      x = hints.I;
      y = hints.aVF ?? hints.II ?? 0;
    } else {
      x = hints.II ?? 0;
      y = hints.aVF ?? 0;
    }
  }

  // Precordial: V ≈ x cos θ + z sin θ (+ small y) → solve z
  let szz = 0;
  let szr = 0;
  let nP = 0;
  (Object.keys(PRECORDIAL_ANGLE_DEG) as (keyof typeof PRECORDIAL_ANGLE_DEG)[]).forEach((lead) => {
    const b = hints[lead];
    if (b == null || !Number.isFinite(b)) return;
    const a = PRECORDIAL_ANGLE_DEG[lead] * DEG;
    const cz = Math.sin(a);
    if (Math.abs(cz) < 0.08) return;
    const residual = b - x * Math.cos(a) - y * 0.12;
    szz += cz * cz;
    szr += cz * residual;
    nP++;
  });
  const z = nP && szz > 1e-8 ? szr / szz : 0.2 * Math.hypot(x, y);

  return { x, y, z };
}

/** Map base×hintWeights through a fitted dipole so all leads obey lead geometry. */
export function leadsFromHintWeights(
  base: number,
  hints: Partial<Record<LeadId, number>>,
  opts?: { /** Keep authored V1–V6 (injury current, etc.); still dipole-fit limbs */ precordial?: "dipole" | "local" },
): Record<LeadId, number> {
  const keys = LEADS.filter((l) => hints[l] != null);
  if (!keys.length) return emptyLeads();
  const v = fitCardiacVector(hints);
  const out = projectCardiacVector(base, v);
  if (opts?.precordial === "local") {
    for (const lead of ["V1", "V2", "V3", "V4", "V5", "V6"] as const) {
      if (hints[lead] != null) out[lead] = base * hints[lead]!;
    }
  }
  return out;
}

/** Einthoven / Goldberger sanity (should be ~0 after projection). */
export function limbLeadResidual(leads: Record<LeadId, number>): { einthoven: number; goldberger: number } {
  return {
    einthoven: leads.I + leads.III - leads.II,
    goldberger: leads.aVR + leads.aVL + leads.aVF,
  };
}
