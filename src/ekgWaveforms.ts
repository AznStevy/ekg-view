import type { FindingId, SegmentId } from "./findings";
import {
  buildPvcSchedule,
  type EctopySiteId,
  type PvcPatternId,
} from "./ectopyFocus";
import { leadsFromHintWeights, projectCardiacVector, vectorFromAxis, type CardiacVector } from "./leadAxes";

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

export const LEADS: LeadId[] = [
  "I",
  "II",
  "III",
  "aVR",
  "aVL",
  "aVF",
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
];

/** Standard 3×4 teaching layout columns */
export const LEAD_GRID: LeadId[][] = [
  ["I", "II", "III"],
  ["aVR", "aVL", "aVF"],
  ["V1", "V2", "V3"],
  ["V4", "V5", "V6"],
];

export type CycleMark = "P" | "PR" | "QRS" | "ST" | "T" | "TP";

export const CYCLE_MARKS: { id: CycleMark; label: string }[] = [
  { id: "P", label: "P" },
  { id: "PR", label: "PR" },
  { id: "QRS", label: "QRS" },
  { id: "ST" as CycleMark, label: "ST" },
  { id: "T", label: "T" },
  { id: "TP", label: "TP" },
];

export type WaveSample = {
  /** Lead II voltage (compat / rhythm strip) */
  v: number;
  leads: Record<LeadId, number>;
  active: SegmentId[];
  phase: string;
  mark: CycleMark;
};

function gauss(t: number, mu: number, sigma: number, amp: number): number {
  const d = (t - mu) / sigma;
  return amp * Math.exp(-0.5 * d * d);
}

function clamp01(t: number): number {
  return ((t % 1) + 1) % 1;
}

/** Morphology widths were authored for ~NSR cycle length */
const MORPH_REF_SEC = 0.86;

/** LAT-map QRS duration (seconds) fed from main / activation vectors */
let mapQrsDurationSec: number | null = null;
let mapCycleSec = MORPH_REF_SEC;

/** Wire activation-map QRS span into authored waveform widths / phase gates. */
export function setMapQrsTiming(opts: { qrsDurationSec: number | null; cycleSec: number }): void {
  mapQrsDurationSec = opts.qrsDurationSec;
  mapCycleSec = Math.max(0.25, opts.cycleSec);
}

function mapQrsSec(fallbackSec: number): number {
  return mapQrsDurationSec ?? fallbackSec;
}

/** Scale gaussian widths so absolute P/QRS/T duration stays NSR-like on any cycle */
function paperScale(cycleSec: number): number {
  return MORPH_REF_SEC / Math.max(0.25, cycleSec);
}

/** Convert absolute seconds → normalized [0,1) phase for a pattern cycle */
function nrm(sec: number, cycleSec: number): number {
  return sec / cycleSec;
}

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

function scaleLeads(
  base: number,
  weights: Partial<Record<LeadId, number>>,
  opts?: { precordial?: "dipole" | "local" },
): Record<LeadId, number> {
  // Local precordials (STEMI etc.) still need limb dipole fit
  if (opts?.precordial === "local") {
    return leadsFromHintWeights(base, weights, opts);
  }
  // Fast path: complete maps that already obey Einthoven (dipole projections)
  // — skip least-squares refit + extra allocations on the hot strip path.
  let complete = true;
  for (const lead of LEADS) {
    if (weights[lead] == null) {
      complete = false;
      break;
    }
  }
  if (complete) {
    const ein = weights.I! + weights.III! - weights.II!;
    if (Math.abs(ein) < 1e-4) {
      const out = emptyLeads();
      for (const lead of LEADS) out[lead] = base * weights[lead]!;
      return out;
    }
  }
  return leadsFromHintWeights(base, weights, opts);
}

function addLeads(a: Record<LeadId, number>, b: Record<LeadId, number>): Record<LeadId, number> {
  const out = emptyLeads();
  for (const lead of LEADS) out[lead] = a[lead] + b[lead];
  return out;
}

function addInto(target: Record<LeadId, number>, add: Record<LeadId, number>): void {
  for (const lead of LEADS) target[lead] += add[lead];
}

/**
 * Normal sinus lead geometry (teaching dipole).
 *
 * Important: a *single* fixed-axis QRS at +60° is nearly orthogonal to aVL
 * (gain ≈ 0), so T would dwarf QRS there, and P/T vanish in V1. Real QRS is
 * multiphasic — septal → main → terminal vectors — which restores qR/rS
 * reciprocity and keeps aVL QRS larger than T.
 */

/** Late left-atrial / mean P ~ +55° (used where a single P map is needed) */
const NSR_P: Partial<Record<LeadId, number>> = projectCardiacVector(1, {
  x: 0.7,
  y: 0.75,
  z: -0.15,
});

/** Concordant T ~ +55° inferior · slight +Z so V2–V6 stay upright; V1 still mildly inverted */
const NSR_T: Partial<Record<LeadId, number>> = projectCardiacVector(1, {
  x: 0.55,
  y: 0.82,
  z: 0.06,
});

/** Septal: rightward / anterior → q in I/aVL/V6, small r in V1 */
const NSR_SEPTAL = projectCardiacVector(1, { x: -0.55, y: 0.05, z: 0.9 });
/** Main free wall: ~+40° (left of +60°) so aVL keeps a real R · mild anterior */
const NSR_MAIN = projectCardiacVector(1, vectorFromAxis(40, 0.3));
/** Terminal: mild rightward / posterior → small S in V1–V2 (not a huge −Z yank) */
const NSR_TERM = projectCardiacVector(1, { x: -0.18, y: -0.12, z: -0.42 });
/** Early right-atrial P (anterior) for biphasic V1 */
const NSR_P_EARLY = projectCardiacVector(1, { x: 0.05, y: 0.45, z: 1.05 });

/**
 * Fine atrial f-wave dipole: rightward + inferior + mild anterior.
 * Classic AF — small undulations, clearest in V1 / inferior, quiet laterally.
 */
const AFIB_F = projectCardiacVector(1, { x: -0.4, y: 0.72, z: 0.28 });

/** Low-amplitude irregular f-wave baseline (shared by AF / tachy–brady). */
function addAfibFwaves(leads: Record<LeadId, number>, tt: number, strength = 1): void {
  // Fewer, quieter harmonics so V1 stays readable without looking like coarse flutter
  for (let i = 0; i < 7; i++) {
    const freq = 22 + i * 4.1;
    const phase = i * 1.7;
    const amp = (0.011 + 0.004 * (i % 3)) * strength;
    const fib =
      Math.sin((tt * freq + phase) * Math.PI * 2) * amp +
      Math.sin((tt * (freq * 1.31) + phase * 0.6) * Math.PI * 2) * amp * 0.45;
    addInto(leads, scaleLeads(fib, AFIB_F));
  }
}

function pWaveLeads(t: number, mu = 0.1, amp = 0.18, sigma = 0.025): Record<LeadId, number> {
  // Biphasic V1 teaching P: early RA (anterior) then LA (posterior) — keep |V1| readable
  const early = scaleLeads(
    gauss(t, mu - sigma * 0.45, sigma * 0.7, amp * 0.85),
    NSR_P_EARLY,
  );
  const late = scaleLeads(
    gauss(t, mu + sigma * 0.35, sigma * 0.85, amp * 0.9),
    NSR_P,
  );
  return addLeads(early, late);
}

function qrsLeads(
  t: number,
  mu = 0.32,
  width = 0.028,
  amp = 1.0,
  q = -0.08,
  s = -0.22,
  weights?: Partial<Record<LeadId, number>>,
): Record<LeadId, number> {
  // Custom map (BBB overlays, hemiblocks, etc.): single envelope × weights
  if (weights) {
    const shape =
      gauss(t, mu - width * 0.55, width * 0.35, q) +
      gauss(t, mu, width * 0.42, amp) +
      gauss(t, mu + width * 0.7, width * 0.4, s);
    return scaleLeads(shape, weights);
  }
  // Default NSR-like multiphasic vectors (septal → main → terminal)
  // Keep septal q and terminal S clearly visible for teaching (still small vs R).
  const septalAmp = Math.max(0.28, Math.abs(q) * 3.5);
  const termAmp = Math.max(0.45, Math.abs(s) * 2.1);
  return addLeads(
    addLeads(
      scaleLeads(gauss(t, mu - width * 0.6, width * 0.42, septalAmp), NSR_SEPTAL),
      scaleLeads(gauss(t, mu, width * 0.45, amp), NSR_MAIN),
    ),
    scaleLeads(gauss(t, mu + width * 0.78, width * 0.48, termAmp), NSR_TERM),
  );
}

function tWaveLeads(
  t: number,
  mu = 0.58,
  amp = 0.32,
  sigma = 0.055,
  weights: Partial<Record<LeadId, number>> = NSR_T,
): Record<LeadId, number> {
  return scaleLeads(gauss(t, mu, sigma, amp), weights);
}

function wideQrsLeads(t: number, mu = 0.32, amp = 0.95, cycleSec = 0.86): Record<LeadId, number> {
  // Widths in absolute seconds so VT (short cycle) stays wide on paper
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  const shape =
    gauss(t, mu - abs(0.035), abs(0.028), -0.2) +
    gauss(t, mu, abs(0.05), amp) +
    gauss(t, mu + abs(0.055), abs(0.04), -0.42) +
    gauss(t, mu + abs(0.1), abs(0.03), 0.22);
  // Extreme / northwest axis · right-precordial positive (typical PVC/VT teaching)
  return scaleLeads(shape, projectCardiacVector(1, { x: -0.55, y: -0.85, z: 0.95 }));
}

/** Thin pacing artifact visible across leads (sharp, brief) */
function paceSpike(t: number, mu: number, amp = 0.55): Record<LeadId, number> {
  const spike = gauss(t, mu, 0.0045, amp) - gauss(t, mu + 0.006, 0.004, amp * 0.35);
  const w: Partial<Record<LeadId, number>> = {
    I: 0.85,
    II: 1.0,
    III: 0.85,
    aVR: 0.7,
    aVL: 0.7,
    aVF: 0.9,
    V1: 0.95,
    V2: 0.9,
    V3: 0.85,
    V4: 0.85,
    V5: 0.85,
    V6: 0.85,
  };
  return scaleLeads(spike, w);
}

/** RV-apical / LBBB-like paced QRS — width tracks LAT map when available */
function pacedQrsLeads(
  t: number,
  mu: number,
  amp = 1.0,
  cycleSec = mapCycleSec,
  qrsSec = mapQrsSec(0.14),
): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  const w = Math.max(0.65, Math.min(2.4, qrsSec / 0.12));
  const shape =
    gauss(t, mu - abs(0.02 * w), abs(0.022 * w), -0.08) +
    gauss(t, mu + abs(0.02 * w), abs(0.05 * w), amp) +
    gauss(t, mu + abs(0.08 * w), abs(0.04 * w), -0.28);
  // RV apical / LBBB-like: leftward · posterior (deep V1)
  return scaleLeads(shape, projectCardiacVector(1, { x: 0.95, y: 0.1, z: -0.9 }));
}

/** RVOT-like paced QRS — inferior axis */
function pacedRvotQrsLeads(
  t: number,
  mu: number,
  amp = 1.0,
  cycleSec = mapCycleSec,
  qrsSec = mapQrsSec(0.13),
): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  const w = Math.max(0.65, Math.min(2.2, qrsSec / 0.12));
  const shape =
    gauss(t, mu - abs(0.015 * w), abs(0.02 * w), -0.06) +
    gauss(t, mu + abs(0.02 * w), abs(0.045 * w), amp) +
    gauss(t, mu + abs(0.07 * w), abs(0.035 * w), -0.22);
  return scaleLeads(shape, projectCardiacVector(1, { x: 0.35, y: -0.85, z: -0.35 }));
}

function lbbbMorphQrs(t: number, mu: number, amp = 1.0, cycleSec = mapCycleSec): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  // Fixed teaching width (~140–160 ms) — do not let LAT-map span warp morphology
  const w = 1.15;
  const shape =
    gauss(t, mu - abs(0.02 * w), abs(0.022 * w), -0.08) +
    gauss(t, mu + abs(0.02 * w), abs(0.045 * w), amp * 0.55) +
    gauss(t, mu + abs(0.07 * w), abs(0.055 * w), amp) +
    gauss(t, mu + abs(0.12 * w), abs(0.035 * w), -0.25);
  // LBBB: broad R I/V6 · deep QS/rS V1 · leftward / posterior
  return scaleLeads(shape, {
    I: 0.95,
    II: 0.35,
    III: -0.55,
    aVR: -0.45,
    aVL: 0.85,
    aVF: -0.15,
    V1: -1.15,
    V2: -0.95,
    V3: -0.35,
    V4: 0.55,
    V5: 0.95,
    V6: 1.05,
  });
}

function rbbbMorphQrs(t: number, mu: number, amp = 1.0, cycleSec = mapCycleSec): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  // Fixed teaching width — classic rsR′ V1 must stay readable
  const w = 1.1;
  const early =
    gauss(t, mu - abs(0.015 * w), abs(0.018 * w), -0.1) +
    gauss(t, mu + abs(0.008 * w), abs(0.022 * w), amp * 0.45);
  const late =
    gauss(t, mu + abs(0.05 * w), abs(0.032 * w), amp * 0.35) +
    gauss(t, mu + abs(0.085 * w), abs(0.038 * w), amp);
  // Early LV (leftward) then late RV (rightward / anterior) → rsR′ V1, wide S I/V6
  const a = scaleLeads(early, {
    I: 0.7,
    II: 0.55,
    III: 0.15,
    aVR: -0.4,
    aVL: 0.45,
    aVF: 0.35,
    V1: -0.35,
    V2: -0.2,
    V3: 0.25,
    V4: 0.7,
    V5: 0.85,
    V6: 0.75,
  });
  const b = scaleLeads(late, {
    I: -0.55,
    II: -0.25,
    III: 0.2,
    aVR: 0.35,
    aVL: -0.4,
    aVF: -0.05,
    V1: 1.25,
    V2: 1.0,
    V3: 0.35,
    V4: -0.15,
    V5: -0.45,
    V6: -0.55,
  });
  return addLeads(a, b);
}

/**
 * Isolated LAFB:
 *   • Left axis (−45° to −90°)
 *   • qR in I, aVL
 *   • rS in II, III, aVF
 *   • R-wave peak time in aVL > 45 ms
 *   • QRS usually < 120 ms
 *
 * Initial vector inferior/rightward (LPF) → small q laterally / small r inferiorly;
 * main vector superior/leftward → tall R I/aVL (late peak), deep S inferior.
 */
function lafbMorphQrs(t: number, mu: number, amp = 1.0, cycleSec = mapCycleSec): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  // Absolute paper times — R peak in aVL intentionally > 45 ms from QRS onset
  const qOn = mu + abs(0.006); // early q / r (~6 ms)
  const rPeak = mu + abs(0.052); // aVL R peak ~52 ms (> 45 ms criterion)
  const sPeak = mu + abs(0.058); // inferior S nadir slightly after R
  const qrsEnd = mu + abs(0.1);

  // —— Lateral leads I / aVL: classic qR ——
  const qR =
    gauss(t, qOn, abs(0.008), -0.22 * amp) + // small q
    gauss(t, rPeak, abs(0.018), 1.15 * amp) + // tall R, delayed peak
    gauss(t, qrsEnd, abs(0.012), -0.06 * amp); // tiny terminal
  const lateral = scaleLeads(qR, {
    I: 0.95,
    aVL: 1.15, // taller / later in aVL (teaching peak-time cue)
    II: 0,
    III: 0,
    aVR: 0,
    aVF: 0,
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: 0.35,
    V6: 0.45,
  });

  // —— Inferior leads II / III / aVF: classic rS (SIII deepest) ——
  const rS =
    gauss(t, qOn, abs(0.008), 0.28 * amp) + // small r
    gauss(t, sPeak, abs(0.02), -1.2 * amp); // deep S
  const inferior = scaleLeads(rS, {
    I: 0,
    aVL: 0,
    II: 0.85,
    III: 1.15, // deepest S → axis left of −45°
    aVR: 0,
    aVF: 1.0,
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: 0,
    V6: 0,
  });

  // aVR: typically small biphasic / net negative with LAD
  const aVR =
    scaleLeads(gauss(t, qOn, abs(0.01), 0.12 * amp) + gauss(t, rPeak, abs(0.018), -0.45 * amp), {
      aVR: 1,
      I: 0,
      II: 0,
      III: 0,
      aVL: 0,
      aVF: 0,
      V1: 0,
      V2: 0,
      V3: 0,
      V4: 0,
      V5: 0,
      V6: 0,
    });

  // Mild precordial continuity (not BBB-wide)
  const prec =
    scaleLeads(gauss(t, rPeak, abs(0.02), 0.55 * amp), {
      V1: -0.45,
      V2: -0.3,
      V3: 0.2,
      V4: 0.7,
      V5: 0.55,
      V6: 0.4,
      I: 0,
      II: 0,
      III: 0,
      aVR: 0,
      aVL: 0,
      aVF: 0,
    });

  return addLeads(addLeads(addLeads(lateral, inferior), aVR), prec);
}

/**
 * Isolated LPFB:
 *   • Right axis deviation > +90°
 *   • rS in I, aVL
 *   • qR in II, III, aVF (RIII often > RII)
 *   • Prolonged R-wave peak time in aVF (> 45 ms)
 *   • QRS usually < 120 ms
 *
 * Initial vector superior/leftward (LAF) → small r laterally / small q inferiorly;
 * main vector inferior/rightward → deep S I/aVL, tall late R inferior.
 */
function lpfbMorphQrs(t: number, mu: number, amp = 1.0, cycleSec = mapCycleSec): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  const qOn = mu + abs(0.006);
  const rPeak = mu + abs(0.052); // aVF R peak ~52 ms (> 45 ms criterion)
  const sPeak = mu + abs(0.058);
  const qrsEnd = mu + abs(0.1);

  // —— Lateral leads I / aVL: classic rS ——
  const rS =
    gauss(t, qOn, abs(0.008), 0.26 * amp) + // small r
    gauss(t, sPeak, abs(0.02), -1.15 * amp); // deep S
  const lateral = scaleLeads(rS, {
    I: 1.0,
    aVL: 1.1,
    II: 0,
    III: 0,
    aVR: 0,
    aVF: 0,
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: 0.15,
    V6: 0.1,
  });

  // —— Inferior leads II / III / aVF: classic qR (RIII > RII) ——
  const qR =
    gauss(t, qOn, abs(0.008), -0.22 * amp) + // small q
    gauss(t, rPeak, abs(0.018), 1.15 * amp) + // tall R, delayed peak
    gauss(t, qrsEnd, abs(0.012), -0.05 * amp);
  const inferior = scaleLeads(qR, {
    I: 0,
    aVL: 0,
    II: 0.9,
    III: 1.2, // RIII > RII → axis ~+120°
    aVR: 0,
    aVF: 1.15, // delayed peak teaching cue
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: 0,
    V6: 0,
  });

  const aVR =
    scaleLeads(gauss(t, qOn, abs(0.01), -0.1 * amp) + gauss(t, rPeak, abs(0.018), 0.35 * amp), {
      aVR: 1,
      I: 0,
      II: 0,
      III: 0,
      aVL: 0,
      aVF: 0,
      V1: 0,
      V2: 0,
      V3: 0,
      V4: 0,
      V5: 0,
      V6: 0,
    });

  const prec =
    scaleLeads(gauss(t, rPeak, abs(0.02), 0.5 * amp), {
      V1: 0.2,
      V2: 0.25,
      V3: 0.3,
      V4: 0.45,
      V5: 0.4,
      V6: 0.3,
      I: 0,
      II: 0,
      III: 0,
      aVR: 0,
      aVL: 0,
      aVF: 0,
    });

  return addLeads(addLeads(addLeads(lateral, inferior), aVR), prec);
}

const VT_DISCORDANT_T = projectCardiacVector(1, { x: 0.5, y: 0.65, z: -0.4 });

type Window = { start: number; end: number; phase: string; active: SegmentId[]; mark: CycleMark };

function phaseFor(t: number, windows: Window[]): Pick<WaveSample, "phase" | "active" | "mark"> {
  for (const w of windows) {
    if (t >= w.start && t < w.end) {
      return { phase: w.phase, active: w.active, mark: w.mark };
    }
  }
  return { phase: "Diastole / TP segment", active: [], mark: "TP" };
}

function pack(
  leads: Record<LeadId, number>,
  meta: Pick<WaveSample, "phase" | "active" | "mark">,
): WaveSample {
  return { v: leads.II, leads, ...meta };
}

const NSR_WINDOWS = (prDelay = 0): Window[] => {
  const d = prDelay * 0.6;
  return [
    { start: 0.05 + d * 0.2, end: 0.16 + d * 0.2, phase: "SA node · atrial depolarization", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
    { start: 0.16 + d * 0.2, end: 0.26 + d, phase: "AV node delay (PR)", active: ["av"], mark: "PR" },
    { start: 0.26 + d, end: 0.3 + d, phase: "His bundle", active: ["his"], mark: "QRS" },
    { start: 0.3 + d, end: 0.34 + d, phase: "Bundle branches", active: ["his", "rbb", "lbb", "lbba", "lbbp"], mark: "QRS" },
    { start: 0.34 + d, end: 0.48 + d, phase: "Purkinje · ventricular depolarization", active: ["purkinjeR", "purkinjeL", "myocardiumV", "rbb", "lbb", "lbba", "lbbp"], mark: "QRS" },
    { start: 0.48 + d, end: 0.54 + d, phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
    { start: 0.54 + d, end: 0.74 + d, phase: "Ventricular repolarization", active: ["myocardiumV"], mark: "T" },
  ];
};

function sampleNsr(t: number, prDelay = 0): WaveSample {
  const tt = clamp01(t);
  const pr = 0.12 + prDelay;
  const qrsMu = 0.2 + pr;
  const tMu = qrsMu + 0.26;
  const leads = addLeads(
    addLeads(pWaveLeads(tt, 0.1), qrsLeads(tt, qrsMu)),
    tWaveLeads(tt, tMu),
  );
  return pack(leads, phaseFor(tt, NSR_WINDOWS(prDelay)));
}

function sampleBrady(t: number): WaveSample {
  return sampleNsr(t);
}

function sampleTachy(t: number): WaveSample {
  const tt = clamp01(t);
  const leads = addLeads(
    addLeads(pWaveLeads(tt, 0.08, 0.14), qrsLeads(tt, 0.28, 0.024, 1.0)),
    tWaveLeads(tt, 0.52, 0.22, 0.04),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.04, end: 0.14, phase: "SA node · rapid atrial depolarization", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.14, end: 0.22, phase: "AV node (short PR)", active: ["av"], mark: "PR" },
      { start: 0.22, end: 0.36, phase: "His–Purkinje · QRS", active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.36, end: 0.42, phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
      { start: 0.42, end: 0.6, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleAfib(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  /** ~5 irregular QRS @ avg 90 bpm → pattern window 3.33 s */
  const CYCLE = 3.33;

  addAfibFwaves(leads, tt, 1);

  // Irregularly irregular R–R (absolute seconds)
  const beatsAbs = [0.18, 0.72, 1.15, 1.95, 2.7];
  const beats = beatsAbs.map((b) => nrm(b, CYCLE));
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "PV triggers · fibrillatory atria · SA quiescent · no P waves",
    active: ["myocardiumA", "internodal"],
    mark: "TP",
  };

  for (const b of beats) {
    // Absolute timing: QRS ~80 ms, QT onset ~280–320 ms later (not glued to QRS)
    const qrsW = 0.08 / CYCLE;
    const tMu = b + 0.3 / CYCLE;
    const tSig = 0.05 / CYCLE;
    const inQrs = tt >= b - 0.02 / CYCLE && tt < b + qrsW;
    const inT = tt >= tMu - 2.2 * tSig && tt < tMu + 2.5 * tSig;
    if (inQrs || inT) {
      leads = addLeads(leads, qrsLeads(tt, b, 0.028 / CYCLE, 1.0, -0.06, -0.18));
      leads = addLeads(leads, tWaveLeads(tt, tMu, 0.28, tSig));
    }
    if (inQrs) {
      meta = {
        phase: "Irregular QRS · no preceding P · atria still fibrillating",
        active: [
          "av",
          "his",
          "rbb",
          "lbb",
          "lbba",
          "lbbp",
          "purkinjeR",
          "purkinjeL",
          "myocardiumV",
          "internodal",
          "myocardiumA",
        ],
        mark: "QRS",
      };
    } else if (inT) {
      meta = {
        phase: "T wave · atria still fibrillating",
        active: ["myocardiumV", "myocardiumA", "internodal"],
        mark: "T",
      };
    }
  }

  // Between ventricular events, keep atrial tissue marked active for the field
  if (meta.mark === "TP") {
    meta = {
      ...meta,
      active: ["myocardiumA", "internodal"],
    };
  }

  return pack(leads, meta);
}

function sampleAflutter(t: number, dir: "ccw" | "cw"): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();

  /**
   * Typical CTI flutter on paper time:
   * Atrial F–F 0.20 s (300/min). 2:1 conduction → vent 150 bpm (R–R 0.40 s).
   * Pattern window = 2 R–R = 0.80 s (exactly 4 F waves + 2 QRS).
   * Pathway schedule in pathwayTiming.flutterCircuitBranches must stay in sync.
   */
  const CYCLE = 0.8;
  const s = paperScale(CYCLE);
  const fPeriodSec = 0.2;
  const period = nrm(fPeriodSec, CYCLE);
  const f0 = nrm(0.04, CYCLE);
  const phase = ((tt - f0) % period + period) % period;
  const u = phase / period;
  const fIndex = Math.min(3, Math.max(0, Math.floor((tt - f0 + 1e-6) / period)));

  if (dir === "ccw") {
    // Modest inferior sawtooth (~¼–⅓ of prior amp) — classic continuous F, not giant
    const inf =
      u < 0.18 ? -0.18 + (u / 0.18) * 0.26 : 0.08 - ((u - 0.18) / 0.82) * 0.26;
    leads = addLeads(
      leads,
      scaleLeads(inf, projectCardiacVector(1, { x: 0.05, y: 1.0, z: 0.05 })),
    );
    const mu = f0 + fIndex * period;
    const v1 = gauss(tt, mu + 0.045 * s, 0.016 * s, 0.12) + gauss(tt, mu + 0.095 * s, 0.014 * s, -0.03);
    leads = addLeads(
      leads,
      scaleLeads(v1, projectCardiacVector(1, { x: -0.15, y: 0.1, z: 0.85 })),
    );
  } else {
    // Reverse typical (CW): broader notched *positive* inferior F; often negative V1
    const inf =
      u < 0.22
        ? -0.02 + (u / 0.22) * 0.1
        : u < 0.48
          ? 0.08 + ((u - 0.22) / 0.26) * 0.1
          : u < 0.62
            ? 0.18 - ((u - 0.48) / 0.14) * 0.06
            : 0.12 - ((u - 0.62) / 0.38) * 0.16;
    leads = addLeads(
      leads,
      scaleLeads(inf, projectCardiacVector(1, { x: -0.12, y: 0.95, z: 0.08 })),
    );
    const mu = f0 + fIndex * period;
    const v1 =
      gauss(tt, mu + 0.05 * s, 0.028 * s, -0.16) + gauss(tt, mu + 0.12 * s, 0.022 * s, 0.035);
    leads = addLeads(
      leads,
      scaleLeads(v1, projectCardiacVector(1, { x: -0.1, y: 0.08, z: 0.9 })),
    );
  }

  const qrsTimes = [nrm(0.16, CYCLE), nrm(0.56, CYCLE)];
  // Limb names follow travel direction (CW reverses each tract)
  const limbsCcw = ["CTI (lat→med)", "septal ascending", "RA roof", "crista descending"] as const;
  const limbsCw = ["crista ascending", "RA roof (→septum)", "septal descending", "CTI (med→lat)"] as const;
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: dir === "ccw" ? "Flutter circuit · CCW" : "Flutter circuit · CW",
    active: ["flutter", "myocardiumA"],
    mark: "P",
  };

  for (let lapI = 0; lapI < 4; lapI++) {
    const base = f0 + lapI * period;
    if (tt >= base && tt < base + period) {
      const frac = (tt - base) / period;
      const limb = Math.min(3, Math.floor(frac * 4));
      const name = dir === "ccw" ? limbsCcw[limb] : limbsCw[limb];
      meta = {
        phase:
          dir === "ccw"
            ? `CCW typical · ${name} · inferior − sawtooth`
            : `CW reverse · ${name} · inferior + F waves`,
        active: ["flutter", "myocardiumA"],
        mark: "P",
      };
    }
  }

  for (const b of qrsTimes) {
    const inQrs = tt >= b - 0.02 * s && tt < b + 0.11 * s;
    const inSt = tt >= b + 0.11 * s && tt < b + 0.16 * s;
    const inT = tt >= b + 0.16 * s && tt < b + 0.24 * s;
    if (inQrs || inSt || inT) {
      leads = addLeads(leads, qrsLeads(tt, b, 0.024 * s, 1.0, -0.05, -0.16));
      leads = addLeads(leads, tWaveLeads(tt, b + 0.15 * s, 0.04, 0.022 * s));
    }
    if (inQrs) {
      meta = {
        phase: "Conducted QRS (2:1) · F waves continue",
        active: ["av", "his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV", "flutter"],
        mark: "QRS",
      };
    } else if (inSt) {
      meta = {
        phase: "ST · flutter continues",
        active: ["myocardiumV", "flutter"],
        mark: "ST",
      };
    } else if (inT) {
      meta = {
        phase: "T wave · flutter continues",
        active: ["myocardiumV", "flutter"],
        mark: "T",
      };
    }
  }

  return pack(leads, meta);
}

function sampleAflutterCcw(t: number): WaveSample {
  return sampleAflutter(t, "ccw");
}

function sampleAflutterCw(t: number): WaveSample {
  return sampleAflutter(t, "cw");
}

function sampleAv1(t: number): WaveSample {
  // Clearly prolonged PR (teaching: PR ≫ 200 ms)
  return sampleNsr(t, 0.2);
}

function sampleAv2i(t: number): WaveSample {
  const tt = clamp01(t);
  /**
   * Classic 4:3 Wenckebach on real paper time (1 large box = 0.2 s).
   * Atrial ~75 bpm (P–P 0.80 s). PR 180 → 260 → 360 ms, then blocked P.
   * Pattern window = 4×P–P so the strip loops cleanly.
   */
  const CYCLE = 3.2;
  const REF = 0.86; // NSR design cycle — keep P/QRS/T absolute widths similar
  const s = REF / CYCLE;
  const abs: { p: number; qrs: number | null }[] = [
    { p: 0.08, qrs: 0.08 + 0.18 },
    { p: 0.88, qrs: 0.88 + 0.26 },
    { p: 1.68, qrs: 1.68 + 0.36 },
    { p: 2.48, qrs: null },
  ];
  const events = abs.map((e) => ({
    p: e.p / CYCLE,
    qrs: e.qrs == null ? null : e.qrs / CYCLE,
  }));

  let leads = emptyLeads();
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Wenckebach sequence",
    active: [],
    mark: "TP",
  };
  for (const e of events) {
    leads = addLeads(leads, pWaveLeads(tt, e.p, 0.18, 0.025 * s));
    if (Math.abs(tt - e.p) < 0.035 * s + 0.01) {
      meta = { phase: "Atrial depolarization", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    }
    if (e.qrs != null) {
      const prSec = (e.qrs - e.p) * CYCLE;
      leads = addLeads(
        leads,
        addLeads(
          qrsLeads(tt, e.qrs, 0.028 * s),
          tWaveLeads(tt, e.qrs + 0.16 * s, 0.22, 0.035 * s),
        ),
      );
      if (tt >= e.qrs - 0.02 * s && tt < e.qrs + 0.11 * s) {
        meta = {
          phase:
            prSec < 0.22
              ? "Conducted (shorter PR)"
              : prSec < 0.32
                ? "Conducted (longer PR)"
                : "Conducted (longest PR)",
          active: ["av", "his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
          mark: "QRS",
        };
      } else if (tt >= e.qrs + 0.11 * s && tt < e.qrs + 0.22 * s) {
        meta = { phase: "T wave", active: ["myocardiumV"], mark: "T" };
      } else if (tt > e.p && tt < e.qrs) {
        meta = { phase: "Lengthening AV delay", active: ["av"], mark: "PR" };
      }
    } else if (tt > e.p && tt < e.p + 0.2 * s + 0.04) {
      meta = { phase: "Blocked P · no ventricular activation", active: ["av"], mark: "PR" };
    }
  }
  return pack(leads, meta);
}

function sampleAv2ii(t: number): WaveSample {
  const tt = clamp01(t);
  /**
   * 3:2 Mobitz II on paper time: constant PR 180 ms, atrial ~71 bpm (P–P 0.84 s),
   * sudden infra-His drop. Pattern = 3×P–P.
   */
  const CYCLE = 2.52;
  const s = paperScale(CYCLE);
  const abs: { p: number; qrs: number | null }[] = [
    { p: 0.1, qrs: 0.1 + 0.18 },
    { p: 0.94, qrs: null },
    { p: 1.78, qrs: 1.78 + 0.18 },
  ];
  const events = abs.map((e) => ({
    p: nrm(e.p, CYCLE),
    qrs: e.qrs == null ? null : nrm(e.qrs, CYCLE),
  }));

  let leads = emptyLeads();
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Mobitz II",
    active: [],
    mark: "TP",
  };
  for (const e of events) {
    leads = addLeads(leads, pWaveLeads(tt, e.p, 0.18, 0.025 * s));
    if (Math.abs(tt - e.p) < 0.035 * s + 0.01) {
      meta = { phase: "P wave", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    }
    if (e.qrs != null) {
      leads = addLeads(
        leads,
        addLeads(
          qrsLeads(tt, e.qrs, 0.028 * s),
          tWaveLeads(tt, e.qrs + 0.16 * s, 0.28, 0.04 * s),
        ),
      );
      if (tt >= e.qrs - 0.02 * s && tt < e.qrs + 0.11 * s) {
        meta = {
          phase: "Conducted · infra-His intact",
          active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
          mark: "QRS",
        };
      } else if (tt >= e.qrs + 0.11 * s && tt < e.qrs + 0.24 * s) {
        meta = { phase: "T wave", active: ["myocardiumV"], mark: "T" };
      } else if (tt > e.p && tt < e.qrs) {
        meta = { phase: "PR interval (stable)", active: ["av"], mark: "PR" };
      }
    } else if (tt > e.p && tt < e.p + 0.2 * s + 0.04) {
      meta = { phase: "Sudden block in His–Purkinje", active: ["his"], mark: "PR" };
    }
  }
  return pack(leads, meta);
}

function sampleAv3Junctional(t: number): WaveSample {
  const tt = clamp01(t);
  /** Atrial ~90 bpm (P–P 0.67 s) · junctional escape ~45 bpm (R–R 1.33 s) */
  const CYCLE = 2.67;
  const s = paperScale(CYCLE);
  const pTimes = [0.1, 0.77, 1.43, 2.1].map((p) => nrm(p, CYCLE));
  const escapes = [0.45, 1.78].map((e) => nrm(e, CYCLE));

  let leads = emptyLeads();
  for (const p of pTimes) leads = addLeads(leads, pWaveLeads(tt, p, 0.16, 0.025 * s));
  for (const escape of escapes) {
    leads = addLeads(
      leads,
      addLeads(qrsLeads(tt, escape, 0.022 * s, 0.95), tWaveLeads(tt, escape + 0.16 * s, 0.28, 0.045 * s)),
    );
  }
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Complete block · junctional escape (supra-His)",
    active: [],
    mark: "TP",
  };
  if (pTimes.some((p) => Math.abs(tt - p) < 0.035 * s + 0.01)) {
    meta = { phase: "Atrial depolarization · blocked at AV node", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  }
  for (const escape of escapes) {
    if (tt >= escape - 0.02 * s && tt < escape + 0.1 * s) {
      meta = {
        phase: "Junctional / His escape · narrow QRS",
        active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      };
    } else if (tt >= escape + 0.1 * s && tt < escape + 0.24 * s) {
      meta = { phase: "Escape T · A–V dissociation", active: ["myocardiumV"], mark: "T" };
    }
  }
  return pack(leads, meta);
}

function sampleAv3(t: number): WaveSample {
  const tt = clamp01(t);
  /** Atrial ~90 bpm · wide ventricular escape ~36 bpm (R–R 1.67 s) */
  const CYCLE = 3.33;
  const s = paperScale(CYCLE);
  const pTimes = [0.12, 0.78, 1.45, 2.11, 2.78].map((p) => nrm(p, CYCLE));
  const escapes = [0.5, 2.17].map((e) => nrm(e, CYCLE));

  let leads = emptyLeads();
  for (const p of pTimes) leads = addLeads(leads, pWaveLeads(tt, p, 0.16, 0.025 * s));
  for (const escape of escapes) {
    // Wide escape — morph authored for ~0.4 s VT cycles
    const vtS = 0.4 / CYCLE;
    const shape =
      gauss(tt, escape - 0.04 * vtS, 0.03 * vtS, -0.15) +
      gauss(tt, escape, 0.055 * vtS, 0.85) +
      gauss(tt, escape + 0.06 * vtS, 0.04 * vtS, -0.35) +
      gauss(tt, escape + 0.1 * vtS, 0.03 * vtS, 0.25);
    const wideW: Partial<Record<LeadId, number>> = {
      I: -0.55,
      II: -0.85,
      III: -0.7,
      aVR: 0.7,
      aVL: -0.2,
      aVF: -0.8,
      V1: 1.1,
      V2: 0.9,
      V3: 0.2,
      V4: -0.55,
      V5: -0.85,
      V6: -0.9,
    };
    leads = addLeads(leads, scaleLeads(shape, wideW));
    leads = addLeads(leads, tWaveLeads(tt, escape + 0.18 * s, -0.22, 0.05 * s));
  }
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Complete block · ventricular escape (infra-His)",
    active: [],
    mark: "TP",
  };
  if (pTimes.some((p) => Math.abs(tt - p) < 0.035 * s + 0.01)) {
    meta = { phase: "Atrial depolarization · blocked below His", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  }
  for (const escape of escapes) {
    if (Math.abs(tt - escape) < 0.07 * s + 0.02) {
      meta = { phase: "Ventricular escape focus · wide QRS", active: ["purkinjeL", "purkinjeR", "myocardiumV"], mark: "QRS" };
    } else if (tt > escape + 0.07 * s && tt < escape + 0.22 * s) {
      meta = { phase: "Escape repolarization · dissociated", active: ["myocardiumV"], mark: "T" };
    }
  }
  return pack(leads, meta);
}

function sampleRbbb(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const qrsEnd = Math.min(0.58, qrsMu + 0.16);
  const mid = qrsMu + (qrsEnd - qrsMu) * 0.4;
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, rbbbMorphQrs(tt, qrsMu, 1.0));
  leads = addLeads(
    leads,
    tWaveLeads(tt, Math.min(0.78, qrsEnd + 0.12), 0.28, 0.05, {
      I: 0.5,
      II: 0.55,
      III: 0.25,
      aVR: -0.4,
      aVL: 0.3,
      aVF: 0.4,
      V1: -0.55,
      V2: -0.4,
      V3: -0.05,
      V4: 0.35,
      V5: 0.5,
      V6: 0.45,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: mid, phase: "Left bundle first · LV (RBB blocked)", active: ["lbb", "lbba", "lbbp", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: mid, end: qrsEnd, phase: "Myocardial spread → RV (RBB blocked)", active: ["myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: Math.min(0.85, qrsEnd + 0.08), phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
      { start: Math.min(0.85, qrsEnd + 0.08), end: 0.95, phase: "Secondary T-wave changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleLbbb(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.34;
  const qrsEnd = Math.min(0.6, qrsMu + 0.18);
  const mid = qrsMu + (qrsEnd - qrsMu) * 0.4;
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, lbbbMorphQrs(tt, qrsMu, 1.0));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, Math.min(0.78, qrsEnd + 0.12), 0.05, 0.35), {
      I: -0.65,
      II: -0.35,
      III: 0.25,
      aVR: 0.5,
      aVL: -0.6,
      aVF: -0.1,
      V1: 0.7,
      V2: 0.55,
      V3: 0.2,
      V4: -0.3,
      V5: -0.65,
      V6: -0.75,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: mid, phase: "Right bundle first · RV (LBB blocked)", active: ["rbb", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: mid, end: qrsEnd, phase: "Myocardial spread → LV (LBB blocked)", active: ["myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: Math.min(0.85, qrsEnd + 0.08), phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
      { start: Math.min(0.85, qrsEnd + 0.08), end: 0.95, phase: "Discordant T waves", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** LAFB — LAD −45°…−90°, qR I/aVL, rS II/III/aVF, R-peak aVL >45 ms */
function sampleLafb(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const qrsEnd = Math.min(0.5, qrsMu + 0.12);
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, lafbMorphQrs(tt, qrsMu, 1.0));
  // Concordant upright T in lateral leads; inferior T may be upright/flat
  leads = addLeads(
    leads,
    tWaveLeads(tt, Math.min(0.72, qrsEnd + 0.14), 0.28, 0.045, {
      I: 0.55,
      II: 0.35,
      III: 0.15,
      aVR: -0.35,
      aVL: 0.6,
      aVF: 0.25,
      V1: -0.15,
      V2: 0.1,
      V3: 0.35,
      V4: 0.5,
      V5: 0.55,
      V6: 0.5,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      {
        start: 0.28,
        end: 0.34,
        phase: "LAFB · early inferior vector (LPF) → q in I/aVL, r in II/III/aVF",
        active: ["rbb", "lbb", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      },
      {
        start: 0.34,
        end: qrsEnd,
        phase: "LAFB · late superior-left R (aVL peak >45 ms) · deep S inferior",
        active: ["myocardiumV", "purkinjeL"],
        mark: "QRS",
      },
      { start: qrsEnd, end: Math.min(0.58, qrsEnd + 0.08), phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: Math.min(0.58, qrsEnd + 0.08), end: 0.78, phase: "T wave", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** LPFB — RAD >+90°, rS I/aVL, qR II/III/aVF, R-peak aVF >45 ms */
function sampleLpfb(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const qrsEnd = Math.min(0.5, qrsMu + 0.12);
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, lpfbMorphQrs(tt, qrsMu, 1.0));
  leads = addLeads(
    leads,
    tWaveLeads(tt, Math.min(0.72, qrsEnd + 0.14), 0.26, 0.045, {
      I: 0.25,
      II: 0.5,
      III: 0.55,
      aVR: -0.3,
      aVL: 0.15,
      aVF: 0.55,
      V1: -0.1,
      V2: 0.15,
      V3: 0.35,
      V4: 0.45,
      V5: 0.4,
      V6: 0.35,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      {
        start: 0.28,
        end: 0.34,
        phase: "LPFB · early superior-left vector (LAF) → r in I/aVL, q inferior",
        active: ["rbb", "lbb", "lbba", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      },
      {
        start: 0.34,
        end: qrsEnd,
        phase: "LPFB · late inferior-right R (aVF peak >45 ms; RIII>RII)",
        active: ["myocardiumV", "purkinjeL"],
        mark: "QRS",
      },
      { start: qrsEnd, end: Math.min(0.58, qrsEnd + 0.08), phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: Math.min(0.58, qrsEnd + 0.08), end: 0.78, phase: "T wave", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** RBBB + left axis (LAFB) — rsR′ V1 with qR I/aVL and rS inferior */
function sampleRbbbLafb(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const qrsEnd = Math.min(0.58, qrsMu + 0.18);
  let leads = pWaveLeads(tt, 0.1);
  // Precordial RBBB pattern
  leads = addLeads(leads, rbbbMorphQrs(tt, qrsMu, 0.9));
  // Overlay classic LAFB limb morph (dominates frontal plane)
  const limb = lafbMorphQrs(tt, qrsMu + 0.01, 0.85);
  leads = addLeads(leads, {
    I: limb.I * 0.85,
    II: limb.II * 0.95,
    III: limb.III,
    aVR: limb.aVR * 0.7,
    aVL: limb.aVL,
    aVF: limb.aVF,
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: limb.V5 * 0.25,
    V6: limb.V6 * 0.3,
  });
  leads = addLeads(
    leads,
    tWaveLeads(tt, Math.min(0.78, qrsEnd + 0.1), 0.22, 0.05, {
      I: 0.35,
      II: -0.15,
      III: -0.25,
      aVL: 0.4,
      aVF: -0.2,
      V1: -0.5,
      V6: 0.25,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.4, phase: "LPF only (RBB + LAF blocked)", active: ["lbb", "lbbp", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: qrsEnd, phase: "Myocardial spread → RV + anterior LV", active: ["myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.75, phase: "Secondary T changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** RBBB + right axis (LPFB) — rsR′ V1 with rS I/aVL and qR inferior */
function sampleRbbbLpfb(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const qrsEnd = Math.min(0.58, qrsMu + 0.18);
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, rbbbMorphQrs(tt, qrsMu, 0.9));
  const limb = lpfbMorphQrs(tt, qrsMu + 0.01, 0.85);
  leads = addLeads(leads, {
    I: limb.I * 0.95,
    II: limb.II,
    III: limb.III,
    aVR: limb.aVR * 0.7,
    aVL: limb.aVL,
    aVF: limb.aVF,
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: limb.V5 * 0.2,
    V6: limb.V6 * 0.25,
  });
  leads = addLeads(
    leads,
    tWaveLeads(tt, Math.min(0.78, qrsEnd + 0.1), 0.22, 0.05, {
      I: -0.15,
      II: 0.3,
      III: 0.35,
      aVL: -0.2,
      aVF: 0.3,
      V1: -0.5,
      V6: 0.2,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.4, phase: "LAF only (RBB + LPF blocked)", active: ["lbb", "lbba", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: qrsEnd, phase: "Myocardial spread → RV + posterior LV", active: ["myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.75, phase: "Secondary T changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** Ectopic atrial P′ axis by focus site (toward AV node from the ectopic origin). */
function pacSitePVector(site: EctopySiteId): CardiacVector {
  switch (site) {
    case "raHigh":
      // Near SA — sinus-like inferior / leftward
      return { x: 0.15, y: 0.7, z: 0.35 };
    case "raLateral":
      // RA free wall — more leftward / slightly superior
      return { x: 0.55, y: -0.25, z: 0.55 };
    case "raLow":
      // Low RA / CTI — inverted inferior (classic teaching PAC)
      return { x: 0.2, y: -0.85, z: 0.15 };
    case "csOstium":
      // CS os — strongly inverted inferior, posterior
      return { x: 0.1, y: -0.95, z: -0.25 };
    case "la":
      // Left atrium — rightward (neg I), often positive V1
      return { x: -0.75, y: 0.15, z: -0.35 };
    default:
      return { x: 0.25, y: -0.75, z: 0.15 };
  }
}

/** Visible ectopic P′ — larger than sinus so it never reads as a junctional (P-less) beat. */
function addPacPWave(
  leads: Record<LeadId, number>,
  tt: number,
  cycle: number,
  pSec: number,
  site: EctopySiteId,
): Record<LeadId, number> {
  const abs = (sec: number) => sec / cycle;
  const vec = projectCardiacVector(1, pacSitePVector(site));
  // Wider + taller than sinus P so morphology (and T+P′ fusion) is obvious on paper
  const shape =
    gauss(tt, abs(pSec) - abs(0.012), abs(0.02), 0.12) +
    gauss(tt, abs(pSec), abs(0.028), 0.32) +
    gauss(tt, abs(pSec) + abs(0.018), abs(0.022), 0.1);
  return addLeads(leads, scaleLeads(shape, vec));
}

function addNarrowBeat(
  leads: Record<LeadId, number>,
  tt: number,
  cycle: number,
  pSec: number,
  opts?: { pac?: boolean; pacSite?: EctopySiteId; amp?: number },
): Record<LeadId, number> {
  const abs = (sec: number) => sec / cycle;
  // Slightly short PR after ectopic P′ (still clearly P′ → QRS, not junctional)
  const pr = opts?.pac ? 0.14 : 0.16;
  const qSec = pSec + pr;
  const tSec = pSec + pr + 0.28;
  const amp = opts?.amp ?? 1;
  let out = leads;
  if (opts?.pac) {
    out = addPacPWave(out, tt, cycle, pSec, opts.pacSite ?? "raLow");
  } else {
    out = addLeads(out, pWaveLeads(tt, abs(pSec), 0.17, abs(0.025)));
  }
  out = addLeads(out, qrsLeads(tt, abs(qSec), abs(0.027), amp, -0.05, -0.16));
  out = addLeads(out, tWaveLeads(tt, abs(tSec), 0.28, abs(0.05)));
  return out;
}

/** Teaching QRS axis / BBB-like morphology by myocardial focus. */
function pvcSiteVector(site: EctopySiteId): { qrs: CardiacVector; lbbbLike: boolean } {
  switch (site) {
    case "rvot":
      // LBBB-like · inferior axis (outflow)
      return { qrs: { x: 0.65, y: 0.9, z: -0.7 }, lbbbLike: true };
    case "rvApex":
      // LBBB-like · superior / leftward
      return { qrs: { x: 0.9, y: -0.55, z: -0.95 }, lbbbLike: true };
    case "rvFreeWall":
      return { qrs: { x: 0.95, y: 0.12, z: -0.85 }, lbbbLike: true };
    case "lvApex":
      // RBBB-like · northwest / superior
      return { qrs: { x: -0.55, y: -0.8, z: 0.75 }, lbbbLike: false };
    case "lvInfero":
      return { qrs: { x: -0.4, y: -0.9, z: 0.7 }, lbbbLike: false };
    case "lvLateral":
    case "lvFreeWall":
      return { qrs: { x: -0.75, y: -0.15, z: 0.95 }, lbbbLike: false };
    case "lvSeptal":
      return { qrs: { x: -0.35, y: -0.2, z: 1.0 }, lbbbLike: false };
    default:
      return { qrs: { x: -0.55, y: -0.85, z: 0.95 }, lbbbLike: false };
  }
}

function pvcMorphQrs(
  t: number,
  mu: number,
  site: EctopySiteId,
  amp = 1.15,
  cycleSec = 0.86,
): Record<LeadId, number> {
  const { qrs, lbbbLike } = pvcSiteVector(site);
  const zx = qrs.z ?? 0;
  const unit = Math.hypot(qrs.x, qrs.y, zx) || 1;
  const weights = projectCardiacVector(1, {
    x: qrs.x / unit,
    y: qrs.y / unit,
    z: zx / unit,
  });
  // Blend site axis with BBB template so precordials still read LBBB- vs RBBB-like
  const template = lbbbLike
    ? projectCardiacVector(1, { x: 0.9, y: 0.15, z: -0.85 })
    : projectCardiacVector(1, { x: -0.4, y: -0.45, z: 1.05 });
  const blended: Partial<Record<LeadId, number>> = {};
  for (const lead of LEADS) {
    blended[lead] = (weights[lead] ?? 0) * 0.7 + (template[lead] ?? 0) * 0.3;
  }
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  const envelope =
    gauss(t, mu - abs(0.02), abs(0.022), -0.1) +
    gauss(t, mu + abs(0.015), abs(0.04), amp * 0.55) +
    gauss(t, mu + abs(0.06), abs(0.048), amp) +
    gauss(t, mu + abs(0.11), abs(0.032), -0.25);
  return scaleLeads(envelope, blended);
}

function addPvcBeat(
  leads: Record<LeadId, number>,
  tt: number,
  cycle: number,
  qSec: number,
  site: EctopySiteId,
): Record<LeadId, number> {
  const abs = (sec: number) => sec / cycle;
  const { qrs } = pvcSiteVector(site);
  const zx = qrs.z ?? 0;
  const unit = Math.hypot(qrs.x, qrs.y, zx) || 1;
  // Discordant T: opposite the PVC QRS vector
  const tVec = projectCardiacVector(1, {
    x: -qrs.x / unit,
    y: -qrs.y / unit,
    z: -zx / unit,
  });
  let out = addLeads(leads, pvcMorphQrs(tt, abs(qSec), site, 1.15, cycle));
  out = addLeads(out, scaleLeads(gauss(tt, abs(qSec + 0.24), abs(0.055), -0.38), tVec));
  return out;
}

function samplePac(t: number): WaveSample {
  return samplePacPattern(t, "raLow");
}

/** Parameterized PAC strip: site shapes P′ morphology; atrial field from that focus. */
export function samplePacPattern(t: number, site: EctopySiteId = "raLow"): WaveSample {
  const tt = clamp01(t);
  /** Multi-beat strip: sinus beats + PACs only (no PVCs), every QRS has a T. */
  const CYCLE = 7.0;
  const abs = (sec: number) => sec / CYCLE;

  // One mid-diastolic PAC (clear P′) + one PAC on the prior T (additive T+P′ fusion)
  const beats: { kind: "sinus" | "pac"; p: number }[] = [
    { kind: "sinus", p: 0.14 },
    { kind: "sinus", p: 0.98 },
    { kind: "pac", p: 1.72 }, // after T of prior (~1.42) — clear ectopic P′
    { kind: "sinus", p: 2.55 }, // incomplete pause / SA reset from PAC
    { kind: "sinus", p: 3.4 },
    { kind: "pac", p: 3.82 }, // lands on prior T (~3.84) — additive interaction
    { kind: "sinus", p: 4.7 },
    { kind: "sinus", p: 5.58 },
  ];

  let leads = emptyLeads();
  for (const b of beats) {
    leads = addNarrowBeat(leads, tt, CYCLE, b.p, {
      pac: b.kind === "pac",
      pacSite: site,
    });
  }

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Diastole", active: [], mark: "TP" };
  for (const b of beats) {
    const pr = b.kind === "pac" ? 0.14 : 0.16;
    const p = abs(b.p);
    const q = abs(b.p + pr);
    const tw = abs(b.p + pr + 0.28);
    if (tt >= p - abs(0.025) && tt < q - abs(0.01)) {
      meta =
        b.kind === "pac"
          ? { phase: "PAC · ectopic P′ (site morphology)", active: ["myocardiumA", "internodal"], mark: "P" }
          : { phase: "Sinus P", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    } else if (tt >= q - abs(0.02) && tt < q + abs(0.1)) {
      meta = {
        phase: b.kind === "pac" ? "PAC conducts · narrow QRS" : "Sinus QRS",
        active: ["av", "his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      };
    } else if (tt >= tw - abs(0.08) && tt < tw + abs(0.1)) {
      meta = { phase: "T wave", active: ["myocardiumV"], mark: "T" };
    }
  }
  // Prefer PAC P′ meta when it overlaps a prior T (additive fusion on paper)
  for (const b of beats) {
    if (b.kind !== "pac") continue;
    const p = abs(b.p);
    if (tt >= p - abs(0.03) && tt < p + abs(0.06)) {
      meta = { phase: "PAC · ectopic P′ (site morphology)", active: ["myocardiumA", "internodal"], mark: "P" };
    }
  }
  return pack(leads, meta);
}

function samplePvc(t: number): WaveSample {
  return samplePvcPattern(t, "trigeminy", 1, "rvot");
}

/** Parameterized PVC strip: site shapes QRS morphology; pattern shapes beat timing. */
export function samplePvcPattern(
  t: number,
  pattern: PvcPatternId,
  seed = 1,
  site: EctopySiteId = "rvot",
): WaveSample {
  const tt = clamp01(t);
  const schedule = buildPvcSchedule(pattern, seed);
  const CYCLE = schedule.cycleSec;
  const abs = (sec: number) => sec / CYCLE;
  const RR = 0.86;

  let leads = emptyLeads();
  for (const p of schedule.sinusP) leads = addNarrowBeat(leads, tt, CYCLE, p);
  for (const e of schedule.pvcEvents) leads = addPvcBeat(leads, tt, CYCLE, e.q, site);

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Diastole", active: [], mark: "TP" };
  for (const pSec of schedule.sinusP) {
    const p = abs(pSec);
    const q = abs(pSec + 0.16);
    const tw = abs(pSec + 0.44);
    if (tt >= p - abs(0.02) && tt < q - abs(0.02)) {
      meta = { phase: "Sinus P", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    } else if (tt >= q - abs(0.02) && tt < q + abs(0.1)) {
      meta = {
        phase: "Sinus QRS",
        active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      };
    } else if (tt >= tw - abs(0.08) && tt < tw + abs(0.1)) {
      meta = { phase: "T wave", active: ["myocardiumV"], mark: "T" };
    }
  }
  for (const e of schedule.pvcEvents) {
    const q = abs(e.q);
    const tw = abs(e.q + 0.24);
    if (tt >= q - abs(0.04) && tt < q + abs(0.16)) {
      meta = { phase: "PVC · wall focus → Purkinje", active: ["myocardiumV", "purkinjeL", "purkinjeR"], mark: "QRS" };
    } else if (tt >= tw - abs(0.06) && tt < tw + abs(0.1)) {
      meta = { phase: "Discordant T after PVC", active: ["myocardiumV"], mark: "T" };
    } else if (tt > tw + abs(0.1) && tt < abs(e.afterSinusQ + 2 * RR - 0.2)) {
      meta = { phase: "Full compensatory pause", active: [], mark: "TP" };
    }
  }
  return pack(leads, meta);
}

function sampleVt(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 0.4;
  const abs = (sec: number) => sec / CYCLE;
  const qrsMu = 0.3;
  const leads = addLeads(
    wideQrsLeads(tt, qrsMu, 1.0, CYCLE),
    scaleLeads(gauss(tt, qrsMu + abs(0.18), abs(0.05), -0.36), VT_DISCORDANT_T),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.08, end: 0.55, phase: "Ventricular reentry · monomorphic", active: ["myocardiumV", "purkinjeL", "purkinjeR"], mark: "QRS" },
      { start: 0.55, end: 0.95, phase: "Wide-complex repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleVtMonoLbbb(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 0.4;
  const abs = (sec: number) => sec / CYCLE;
  const qrsMu = 0.28;
  let leads = lbbbMorphQrs(tt, qrsMu, 1.0, CYCLE);
  // Discordant T (opposite LBBB vector)
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, qrsMu + abs(0.18), abs(0.05), 0.34), projectCardiacVector(1, { x: -0.7, y: -0.2, z: 0.75 })),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.08, end: 0.55, phase: "Monomorphic VT · LBBB morphology", active: ["myocardiumV", "purkinjeR", "rbb"], mark: "QRS" },
      { start: 0.55, end: 0.95, phase: "Discordant T", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleVtMonoRbbb(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 0.4;
  const abs = (sec: number) => sec / CYCLE;
  const qrsMu = 0.28;
  let leads = rbbbMorphQrs(tt, qrsMu, 1.0, CYCLE);
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, qrsMu + abs(0.18), abs(0.05), 0.32), projectCardiacVector(1, { x: 0.55, y: 0.4, z: -0.7 })),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.08, end: 0.55, phase: "Monomorphic VT · RBBB morphology", active: ["myocardiumV", "purkinjeL", "lbb"], mark: "QRS" },
      { start: 0.55, end: 0.95, phase: "Secondary T changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleVtPoly(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  const CYCLE = 2.0;
  const abs = (sec: number) => sec / CYCLE;

  // Multi-beat teaching strip: wide QRS, beat-to-beat axis / polarity shifts
  const nBeats = 6;
  const beatRr = 1 / nBeats;
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Polymorphic VT",
    active: ["myocardiumV"],
    mark: "QRS",
  };

  for (let i = 0; i < nBeats; i++) {
    const mu = (i + 0.38) * beatRr;
    const twist = Math.sin((i / 2.8) * Math.PI + 0.4);
    const pol = twist >= 0 ? 1 : -1;
    const amp = 0.85 + 0.2 * Math.abs(twist);
    const shape =
      gauss(tt, mu - abs(0.04), abs(0.03), -0.22 * pol * amp) +
      gauss(tt, mu, abs(0.05), pol * amp) +
      gauss(tt, mu + abs(0.055), abs(0.04), -0.45 * pol * amp) +
      gauss(tt, mu + abs(0.1), abs(0.03), 0.22 * pol * amp);

    const axis = twist;
    const weights = projectCardiacVector(1, {
      x: -0.35 + 0.55 * axis,
      y: -0.55 * pol,
      z: 0.75 * pol,
    });
    leads = addLeads(leads, scaleLeads(shape, weights));
    leads = addLeads(
      leads,
      scaleLeads(gauss(tt, mu + abs(0.18), abs(0.05), -0.32 * pol * amp), VT_DISCORDANT_T),
    );

    if (Math.abs(tt - mu) < abs(0.08)) {
      meta = {
        phase: "Polymorphic VT · wide QRS · shifting axis",
        active: ["myocardiumV", "purkinjeL", "purkinjeR"],
        mark: "QRS",
      };
    }
  }

  return pack(leads, meta);
}

function sampleTorsades(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  const CYCLE = 5.0;
  const s = paperScale(CYCLE);
  const paper = tt * CYCLE;

  // Short long-QT → R-on-T, then continuous high-amp TdP for most of the strip
  const tdpStartSec = 0.85;
  if (paper < tdpStartSec + 0.04) {
    leads = addLeads(leads, pWaveLeads(tt, nrm(0.08, CYCLE), 0.12, 0.022 * s));
    leads = addLeads(leads, qrsLeads(tt, nrm(0.2, CYCLE), 0.025 * s, 0.7, -0.05, -0.12));
    leads = addLeads(leads, tWaveLeads(tt, nrm(0.42, CYCLE), 0.5, 0.09 * s));
    leads = addLeads(leads, scaleLeads(gauss(tt, nrm(0.62, CYCLE), 0.06 * s, 0.18), NSR_T));

    const pvcMu = nrm(0.75, CYCLE);
    const vtS = 0.38 / CYCLE;
    leads = addLeads(
      leads,
      scaleLeads(
        gauss(tt, pvcMu - 0.05 * vtS, 0.035 * vtS, -0.22) +
          gauss(tt, pvcMu, 0.07 * vtS, 1.0) +
          gauss(tt, pvcMu + 0.07 * vtS, 0.05 * vtS, -0.5) +
          gauss(tt, pvcMu + 0.12 * vtS, 0.04 * vtS, 0.3),
        {
          I: -0.5,
          II: -1.0,
          III: -0.8,
          aVR: 0.7,
          aVL: -0.15,
          aVF: -0.95,
          V1: 1.15,
          V2: 0.95,
          V3: 0.2,
          V4: -0.55,
          V5: -0.9,
          V6: -0.95,
        },
      ),
    );
  }

  // Continuous TdP: large AM sine that always swings ± through the isoelectric line
  if (paper >= tdpStartSec - 0.05) {
    const u = Math.max(0, paper - tdpStartSec);
    const fade =
      paper < tdpStartSec ? Math.max(0, (paper - (tdpStartSec - 0.05)) / 0.05) : 1;

    // ~220/min with slight RR wander
    const phase = 2 * Math.PI * (3.7 * u + 0.06 * Math.sin(2.0 * u));

    // Spindle envelope (~2.3 s per full wax–wane — longer large oscillations)
    const spindle =
      0.18 +
      0.82 * Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * 0.43 * u + 0.35), 1.2);

    // Slow axis twist — successive spindles point different directions
    const twist = 2 * Math.PI * 0.36 * u + 0.2;
    const vx = Math.cos(twist) * 1.05;
    const vy = Math.sin(twist) * 1.25;
    const vz = Math.cos(twist * 0.7 + 0.8) * 1.0;

    // Odd-harmonic carrier only → odd symmetry → equal peaks above AND below zero
    // (even harmonics were biasing cycles to one side of the baseline)
    const carrier =
      Math.sin(phase) +
      0.32 * Math.sin(3 * phase) +
      0.12 * Math.sin(5 * phase);

    // Tall vs NSR but stays mostly on paper (~1.6 mV peaks)
    const amp = 1.65 * spindle * fade;
    leads = addLeads(leads, projectCardiacVector(amp * carrier, { x: vx, y: vy, z: vz }));

    // Light polymorphic overlay (also odd-ish) so morphology shifts without DC bias
    const twist2 = twist * 1.2 + 0.9;
    const morph = 0.22 * Math.sin(phase * 1.05 + 0.6) + 0.1 * Math.sin(3 * phase * 1.05 + 1.1);
    leads = addLeads(
      leads,
      projectCardiacVector(amp * morph, {
        x: Math.cos(twist2) * 0.9,
        y: Math.sin(twist2),
        z: Math.sin(twist2 * 0.5) * 0.75,
      }),
    );
  }

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Torsades de pointes",
    active: ["myocardiumV"],
    mark: "QRS",
  };
  if (tt < nrm(0.15, CYCLE))
    meta = { phase: "Sinus P (long-QT context)", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  else if (tt < nrm(0.3, CYCLE))
    meta = { phase: "Sinus QRS", active: ["his", "rbb", "lbb", "myocardiumV"], mark: "QRS" };
  else if (tt < nrm(0.7, CYCLE))
    meta = { phase: "Prolonged QT / U wave", active: ["myocardiumV"], mark: "T" };
  else if (tt < nrm(0.85, CYCLE))
    meta = { phase: "R-on-T PVC · initiates TdP", active: ["myocardiumV", "purkinjeL"], mark: "QRS" };
  else
    meta = { phase: "Twisting polymorphic VT (TdP)", active: ["myocardiumV", "purkinjeL", "purkinjeR"], mark: "QRS" };

  return pack(leads, meta);
}

function sampleVf(t: number, kind: "coarse" | "fine" = "coarse"): WaveSample {
  const tt = clamp01(t);
  const leads = emptyLeads();
  // Chaotic VF — incommensurate harmonics + wandering dipole so the strip
  // doesn't look like a looping sine stack (cycleSec ~4.5 s).
  // Strength relative to ~1.0 QRS: coarse ≈ mid-QRS undulations; fine clearly > asystole.
  const strength = kind === "coarse" ? 2.6 : 1.15;
  // Slow axis wander (different rates → aperiodic lead polarity)
  const ax =
    -0.2 +
    0.55 * Math.sin(tt * Math.PI * 2 * 1.37 + 0.4) +
    0.35 * Math.sin(tt * Math.PI * 2 * 3.11 + 1.9);
  const ay =
    -0.45 +
    0.5 * Math.cos(tt * Math.PI * 2 * 0.83 + 0.2) +
    0.4 * Math.sin(tt * Math.PI * 2 * 2.67 + 0.7);
  const az =
    0.55 +
    0.45 * Math.sin(tt * Math.PI * 2 * 1.91 + 2.1) +
    0.3 * Math.cos(tt * Math.PI * 2 * 4.43);
  const fibW = projectCardiacVector(1, { x: ax, y: ay, z: az });
  const fibW2 = projectCardiacVector(1, { x: -ay * 0.85, y: az * 0.7, z: ax * 0.55 });

  const nHarm = kind === "coarse" ? 15 : 20;
  const baseFreq = kind === "coarse" ? 5.5 : 15;
  const freqSpread = kind === "coarse" ? 9.5 : 22;
  // Irrational-ish steps so phases never re-lock within one pattern window
  const PHI = 1.6180339887;
  for (let i = 0; i < nHarm; i++) {
    const seed = i * 2.718281828 + (kind === "coarse" ? 0.17 : 1.31);
    const freq = baseFreq + ((i * PHI * 3.7) % freqSpread);
    // Continuous amp / freq jitter (product of slow sines → irregular envelope)
    const env =
      0.55 +
      0.3 * Math.sin(tt * Math.PI * 2 * (1.1 + i * 0.37) + seed) *
        Math.sin(tt * Math.PI * 2 * (2.7 + i * 0.19) + seed * 1.7) +
      0.2 * Math.sin(tt * Math.PI * 2 * (0.41 + i * 0.11) + seed * 0.5);
    const freqJ =
      1 +
      0.4 * Math.sin(tt * Math.PI * 2 * (0.7 + i * 0.23) + seed * 2.1) +
      0.2 * Math.sin(tt * Math.PI * 2 * (3.3 + i * 0.09) + seed);
    const amp = (0.05 + 0.035 * Math.abs(Math.sin(seed * 3.1))) * strength * Math.max(0.35, env);
    const slowW = kind === "coarse" ? 0.6 : 0.28;
    const midW = kind === "coarse" ? 0.48 : 0.7;
    const hiW = kind === "coarse" ? 0.35 : 0.55;
    const ph = seed * 1.3;
    const v =
      Math.sin((tt * freq * freqJ + ph) * Math.PI * 2) * amp +
      Math.sin((tt * freq * 1.732 * freqJ + ph * 0.6) * Math.PI * 2) * amp * midW +
      Math.sin((tt * freq * 0.27 * (1 + 0.35 * Math.sin(tt * 5.1 + i)) + ph) * Math.PI * 2) *
        amp *
        slowW +
      Math.sin((tt * freq * (PHI + 0.3) + ph * 2.2) * Math.PI * 2) * amp * hiW;
    // Mix primary + secondary dipole irregularly
    const mix = 0.55 + 0.45 * Math.sin(tt * Math.PI * 2 * (0.55 + i * 0.13) + seed);
    addInto(leads, scaleLeads(v * mix, fibW));
    addInto(leads, scaleLeads(v * (1 - mix) * 0.85, fibW2));
  }

  // Sparse irregular "bursts" so peaks don't look metronomic
  const burstN = kind === "coarse" ? 7 : 5;
  for (let b = 0; b < burstN; b++) {
    const mu = (0.07 + ((b * PHI * 0.37) % 0.88) + 0.04 * Math.sin(b * 5.1)) % 1;
    const wid = (kind === "coarse" ? 0.028 : 0.012) * (1 + 0.5 * Math.sin(b * 2.7));
    const bang = gauss(tt, mu, wid, (kind === "coarse" ? 0.35 : 0.12) * strength * (0.6 + 0.4 * Math.sin(b)));
    const flip = b % 2 === 0 ? 1 : -1;
    addInto(leads, scaleLeads(bang * flip, b % 3 === 0 ? fibW2 : fibW));
  }

  return pack(leads, {
    phase:
      kind === "coarse"
        ? "Coarse VF · large chaotic undulations · no QRS"
        : "Fine VF · low-amplitude chaos · no QRS",
    active: ["myocardiumV"],
    mark: "TP",
  });
}

function sampleVfCoarse(t: number): WaveSample {
  return sampleVf(t, "coarse");
}

function sampleVfFine(t: number): WaveSample {
  return sampleVf(t, "fine");
}

function sampleAvnrtTypical(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 0.33;
  const abs = (sec: number) => sec / CYCLE;
  // Typical slow–fast: narrow QRS, very short RP · retrograde P rides on early T (P-on-T)
  const qrsMu = 0.2;
  let leads = qrsLeads(tt, qrsMu, abs(0.022), 1.0);
  // Retrograde P in early ST / T upslope (pseudo-r′ V1, inverted inferior)
  const retro =
    gauss(tt, qrsMu + abs(0.07), abs(0.016), 0.14) + gauss(tt, qrsMu + abs(0.09), abs(0.014), 0.08);
  leads = addLeads(
    leads,
    scaleLeads(retro, projectCardiacVector(1, { x: -0.15, y: -0.85, z: 0.35 })),
  );
  // T later so ST is visible; P sits on the upslope → classic P-on-T look
  leads = addLeads(leads, tWaveLeads(tt, qrsMu + abs(0.2), 0.26, abs(0.045)));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.0, end: 0.12, phase: "Typical AVNRT · slow pathway anterograde", active: ["avnrtSlow", "av"], mark: "PR" },
      {
        start: 0.12,
        end: 0.34,
        phase: "His–Purkinje · narrow QRS",
        active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      },
      {
        start: 0.34,
        end: 0.48,
        phase: "Retrograde fast pathway · P-on-T",
        active: ["avnrtFast", "av", "internodal", "myocardiumA", "myocardiumV"],
        mark: "ST",
      },
      { start: 0.48, end: 0.85, phase: "T wave · next cycle imminent", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleAvnrtAtypical(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 0.38;
  const abs = (sec: number) => sec / CYCLE;
  // Fast–slow: narrow QRS, long RP · inverted P well after QRS / before next
  const qrsMu = 0.18;
  let leads = qrsLeads(tt, qrsMu, abs(0.022), 1.0);
  leads = addLeads(leads, tWaveLeads(tt, qrsMu + abs(0.16), 0.24, abs(0.04)));
  // Late retrograde P (slow pathway) — long RP, inverted inferior
  const retro =
    gauss(tt, qrsMu + abs(0.2), abs(0.018), 0.16) + gauss(tt, qrsMu + abs(0.22), abs(0.014), 0.1);
  leads = addLeads(
    leads,
    scaleLeads(retro, projectCardiacVector(1, { x: -0.1, y: -0.9, z: 0.25 })),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.0, end: 0.1, phase: "Atypical AVNRT · fast pathway anterograde", active: ["avnrtFast", "av"], mark: "PR" },
      {
        start: 0.1,
        end: 0.32,
        phase: "His–Purkinje · narrow QRS",
        active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      },
      { start: 0.32, end: 0.42, phase: "T wave", active: ["myocardiumV"], mark: "T" },
      { start: 0.42, end: 0.62, phase: "Retrograde slow pathway · long-RP P", active: ["avnrtSlow", "av", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.62, end: 0.9, phase: "Diastolic pause · next anterograde fast", active: [], mark: "TP" },
    ]),
  );
}

function sampleAvrtOrtho(t: number, side: "left" | "right" = "left"): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 0.28;
  const abs = (sec: number) => sec / CYCLE;
  const qrsMu = abs(0.05);
  let leads = qrsLeads(tt, qrsMu, abs(0.02), 1.0);
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, qrsMu + abs(0.045), abs(0.032), 0.14), {
      I: -0.3,
      II: -0.5,
      III: -0.38,
      aVR: 0.32,
      aVL: -0.12,
      aVF: -0.45,
      V1: 0.08,
      V2: -0.12,
      V3: -0.3,
      V4: -0.4,
      V5: -0.45,
      V6: -0.4,
    }),
  );
  leads = addLeads(leads, tWaveLeads(tt, qrsMu + abs(0.09), 0.2, abs(0.032)));
  const retro =
    gauss(tt, qrsMu + abs(0.14), abs(0.014), 0.2) +
    gauss(tt, qrsMu + abs(0.155), abs(0.011), 0.12);
  // Eccentric atrial activation · left-lateral (+X) vs right-lateral (−X)
  const atrVec =
    side === "left"
      ? { x: 0.7, y: -0.45, z: 0.4 }
      : { x: -0.65, y: -0.4, z: 0.55 };
  leads = addLeads(leads, scaleLeads(retro, projectCardiacVector(1, atrVec)));
  const ap = side === "left" ? "accessory" : "accessoryR";
  const purk = side === "left" ? "purkinjeL" : "purkinjeR";
  const fasc = side === "left" ? "lbba" : "rbb";

  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.0, end: 0.12, phase: `Orthodromic · AV → His (${side} Kent)`, active: ["av", "his"], mark: "PR" },
      {
        start: 0.12,
        end: 0.32,
        phase: "His–Purkinje · narrow QRS (no delta)",
        active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      },
      {
        start: 0.32,
        end: 0.55,
        phase: `Up ${side} Kent from Purkinje tip`,
        active: [ap, fasc, purk, "myocardiumV"],
        mark: "ST",
      },
      {
        start: 0.55,
        end: 0.78,
        phase: "Long-RP retrograde P · return to AV",
        active: [ap, "av", "myocardiumA"],
        mark: "P",
      },
      { start: 0.78, end: 0.95, phase: "Next AV anterograde", active: ["av"], mark: "TP" },
    ]),
  );
}

function sampleAvrtAnti(t: number, side: "left" | "right" = "left"): WaveSample {
  const tt = clamp01(t);
  // Prominent delta like classic WPW, but fully preexcited (no fusion) at SVT rate
  // Left Kent → RBBB-like ( +V1 ); right Kent → LBBB-like ( −V1 )
  const deltaW: Partial<Record<LeadId, number>> =
    side === "left"
      ? {
          I: 0.7,
          II: 0.55,
          III: 0.15,
          aVR: -0.55,
          aVL: 0.55,
          aVF: 0.35,
          V1: 0.85,
          V2: 0.9,
          V3: 0.75,
          V4: 0.7,
          V5: 0.65,
          V6: 0.6,
        }
      : {
          I: 0.75,
          II: 0.55,
          III: 0.1,
          aVR: -0.5,
          aVL: 0.65,
          aVF: 0.25,
          V1: -0.75,
          V2: -0.55,
          V3: 0.35,
          V4: 0.7,
          V5: 0.85,
          V6: 0.9,
        };
  const wideW: Partial<Record<LeadId, number>> =
    side === "left"
      ? {
          I: 0.85,
          II: 0.7,
          III: 0.2,
          aVR: -0.7,
          aVL: 0.65,
          aVF: 0.45,
          V1: 0.95,
          V2: 1.0,
          V3: 0.85,
          V4: 0.9,
          V5: 0.85,
          V6: 0.8,
        }
      : {
          I: 0.9,
          II: 0.65,
          III: 0.12,
          aVR: -0.6,
          aVL: 0.75,
          aVF: 0.3,
          V1: -0.9,
          V2: -0.7,
          V3: 0.4,
          V4: 0.85,
          V5: 1.0,
          V6: 1.05,
        };

  // Slow, obvious delta upstroke (WPW-style amplitudes) then wide body
  const delta =
    gauss(tt, 0.06, 0.028, 0.28) +
    gauss(tt, 0.12, 0.032, 0.55) +
    gauss(tt, 0.18, 0.03, 0.42);
  let leads = scaleLeads(delta, deltaW);
  const qrsBody =
    gauss(tt, 0.26, 0.03, 1.0) +
    gauss(tt, 0.32, 0.028, 0.35) +
    gauss(tt, 0.38, 0.026, -0.28) +
    gauss(tt, 0.44, 0.022, -0.12);
  leads = addLeads(leads, scaleLeads(qrsBody, wideW));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.55, 0.05, 0.28), {
      I: -0.5,
      II: -0.35,
      III: side === "left" ? -0.12 : 0.1,
      aVR: 0.35,
      aVL: -0.4,
      aVF: side === "left" ? -0.25 : -0.1,
      V1: side === "left" ? -0.5 : 0.45,
      V2: side === "left" ? -0.55 : 0.35,
      V3: -0.35,
      V4: -0.3,
      V5: -0.35,
      V6: -0.35,
    }),
  );
  const retro = gauss(tt, 0.5, 0.014, 0.12) + gauss(tt, 0.53, 0.01, 0.07);
  leads = addLeads(
    leads,
    scaleLeads(retro, projectCardiacVector(1, { x: -0.15, y: -0.8, z: 0.25 })),
  );

  const ap = side === "left" ? "accessory" : "accessoryR";
  const purk = side === "left" ? "purkinjeL" : "purkinjeR";
  const fasc = side === "left" ? "lbba" : "rbb";
  const bundle = side === "left" ? "lbb" : "rbb";

  return pack(
    leads,
    phaseFor(tt, [
      {
        start: 0.0,
        end: 0.3,
        phase: `Antidromic · down ${side} Kent · prominent delta`,
        active: [ap, purk, "myocardiumV"],
        mark: "QRS",
      },
      {
        start: 0.3,
        end: 0.55,
        phase: "Wide fully preexcited QRS (VT mimic)",
        active: [ap, purk, fasc, "myocardiumV"],
        mark: "QRS",
      },
      {
        start: 0.55,
        end: 0.78,
        phase: "Up Purkinje / fascicle → His → AV",
        active: [purk, fasc, bundle, "his", "av", "myocardiumV"],
        mark: "ST",
      },
      {
        start: 0.78,
        end: 0.95,
        phase: "Atrial corridor → Kent (loop closes)",
        active: ["av", ap, "myocardiumA"],
        mark: "P",
      },
    ]),
  );
}

function sampleAsystole(t: number): WaveSample {
  const tt = clamp01(t);
  // Near-flatline with tiny residual noise (lead check teaching cue)
  const noise = 0.008 * Math.sin(tt * 40) + 0.005 * Math.sin(tt * 97 + 1.3);
  const leads = scaleLeads(noise, {
    I: 0.6,
    II: 1,
    III: 0.7,
    aVR: 0.5,
    aVL: 0.4,
    aVF: 0.7,
    V1: 0.85,
    V2: 0.7,
    V3: 0.55,
    V4: 0.5,
    V5: 0.45,
    V6: 0.4,
  });
  return pack(leads, {
    phase: "Asystole · no depolarization",
    active: [],
    mark: "TP",
  });
}

/** Shared ST-elevation / injury morphology with lead-local weights. */
function sampleStemiTerritory(
  t: number,
  opts: {
    stW: Partial<Record<LeadId, number>>;
    tW: Partial<Record<LeadId, number>>;
    qW?: Partial<Record<LeadId, number>>;
    stAmp?: number;
    tAmp?: number;
    qAmp?: number;
    qrsDetail: string;
    stDetail: string;
    tDetail: string;
  },
): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const tMu = 0.62;
  const stAmp = opts.stAmp ?? 0.55;
  const tAmp = opts.tAmp ?? 0.5;

  let leads = pWaveLeads(tt, 0.1);
  if (opts.qW && (opts.qAmp ?? 0) !== 0) {
    leads = addLeads(
      leads,
      scaleLeads(gauss(tt, qrsMu - 0.03, 0.018, opts.qAmp ?? -0.4), opts.qW, { precordial: "local" }),
    );
  }
  leads = addLeads(leads, qrsLeads(tt, qrsMu, 0.028, 0.95, -0.05, -0.18));

  let st = 0;
  if (tt > qrsMu + 0.03 && tt < 0.78) {
    const u = (tt - (qrsMu + 0.03)) / (0.78 - (qrsMu + 0.03));
    st = u < 0.25 ? stAmp * Math.sin((u / 0.25) * Math.PI * 0.5) : stAmp + 0.1 * Math.sin((u - 0.25) * Math.PI);
  }
  leads = addLeads(leads, scaleLeads(st, opts.stW, { precordial: "local" }));
  leads = addLeads(leads, scaleLeads(gauss(tt, tMu, 0.07, tAmp), opts.tW, { precordial: "local" }));

  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.4, phase: opts.qrsDetail, active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: 0.55, phase: opts.stDetail, active: ["myocardiumV"], mark: "ST" },
      { start: 0.55, end: 0.78, phase: opts.tDetail, active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleStemi(t: number): WaveSample {
  return sampleStemiTerritory(t, {
    qW: { V1: 1, V2: 1, V3: 0.85, V4: 0.35, I: 0.05, aVL: 0.08 },
    qAmp: -0.45,
    stW: {
      I: 0.2,
      II: -0.35,
      III: -0.4,
      aVR: 0.15,
      aVL: 0.35,
      aVF: -0.4,
      V1: 0.9,
      V2: 1.15,
      V3: 1.2,
      V4: 1.0,
      V5: 0.35,
      V6: 0.1,
    },
    tW: {
      I: 0.25,
      II: -0.1,
      III: -0.15,
      aVL: 0.3,
      aVF: -0.12,
      V1: 0.7,
      V2: 1.0,
      V3: 1.05,
      V4: 0.9,
      V5: 0.35,
      V6: 0.15,
    },
    qrsDetail: "QRS · anterior Q waves",
    stDetail: "Injury current · ST elevation V1–V4",
    tDetail: "Hyperacute T · ongoing injury",
  });
}

function sampleStemiInferior(t: number): WaveSample {
  return sampleStemiTerritory(t, {
    qW: { II: 0.7, III: 1, aVF: 0.9, I: 0.1 },
    qAmp: -0.35,
    stW: {
      I: -0.35,
      II: 1.0,
      III: 1.15,
      aVR: -0.15,
      aVL: -0.45,
      aVF: 1.1,
      V1: 0.1,
      V2: -0.15,
      V3: -0.1,
      V4: 0.15,
      V5: 0.25,
      V6: 0.3,
    },
    tW: {
      I: -0.2,
      II: 0.85,
      III: 0.95,
      aVL: -0.3,
      aVF: 0.9,
      V5: 0.25,
      V6: 0.3,
    },
    qrsDetail: "QRS · inferior Q waves",
    stDetail: "Injury current · ST elevation II · III · aVF",
    tDetail: "Hyperacute inferior T waves",
  });
}

function sampleStemiLateral(t: number): WaveSample {
  return sampleStemiTerritory(t, {
    qW: { I: 0.8, aVL: 1, V5: 0.7, V6: 0.85 },
    qAmp: -0.35,
    stW: {
      I: 1.0,
      II: -0.2,
      III: -0.45,
      aVR: -0.25,
      aVL: 1.1,
      aVF: -0.35,
      V1: -0.1,
      V2: -0.05,
      V3: 0.15,
      V4: 0.45,
      V5: 1.0,
      V6: 1.05,
    },
    tW: {
      I: 0.85,
      aVL: 0.95,
      III: -0.25,
      V4: 0.4,
      V5: 0.9,
      V6: 0.95,
    },
    qrsDetail: "QRS · lateral Q waves",
    stDetail: "Injury current · ST elevation I · aVL · V5–V6",
    tDetail: "Hyperacute lateral T waves",
  });
}

function sampleStemiAnterolateral(t: number): WaveSample {
  return sampleStemiTerritory(t, {
    qW: { V2: 0.7, V3: 0.9, V4: 0.85, V5: 0.5, I: 0.4, aVL: 0.55 },
    qAmp: -0.4,
    stAmp: 0.6,
    stW: {
      I: 0.75,
      II: -0.25,
      III: -0.4,
      aVR: 0.1,
      aVL: 0.85,
      aVF: -0.35,
      V1: 0.45,
      V2: 1.05,
      V3: 1.2,
      V4: 1.15,
      V5: 1.0,
      V6: 0.75,
    },
    tW: {
      I: 0.6,
      aVL: 0.7,
      V2: 0.95,
      V3: 1.05,
      V4: 1.0,
      V5: 0.85,
      V6: 0.65,
    },
    qrsDetail: "QRS · anterolateral injury",
    stDetail: "Extensive STE · V2–V6 · I · aVL",
    tDetail: "Hyperacute anterolateral T waves",
  });
}

function sampleStemiPosterior(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const tMu = 0.58;
  let leads = pWaveLeads(tt, 0.1);

  /**
   * Acute posterior MI on a standard 12-lead (mirror image of posterior STE):
   * - R-dominant V1–V2 (R/S ≥ 1) — mirror of posterior Q
   * - Horizontal ST depression V1–V3 — mirror of posterior STE
   * - Tall upright T V1–V2 — acute (mirror of inverted posterior T)
   * Mild inferior STE often coexists (RCA/LCx) but should not dominate.
   */
  // R-dominant right precordials; avoid deep terminal S that would undo the tall-R cue
  const qShape = gauss(tt, qrsMu - 0.028, 0.016, -0.12);
  const rShape = gauss(tt, qrsMu, 0.032, 1.05);
  const sShape = gauss(tt, qrsMu + 0.045, 0.022, -0.18);
  leads = addLeads(
    leads,
    scaleLeads(qShape + rShape + sShape, {
      I: 0.5,
      II: 0.45,
      III: 0.3,
      aVR: -0.35,
      aVL: 0.3,
      aVF: 0.35,
      V1: 1.2,
      V2: 1.1,
      V3: 0.55,
      V4: 0.4,
      V5: 0.45,
      V6: 0.5,
    }, { precordial: "local" }),
  );
  // Extra R boost V1–V2 so R clearly dominates S
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, qrsMu + 0.005, 0.028, 0.55), {
      V1: 1.0,
      V2: 0.9,
      V3: 0.25,
    }, { precordial: "local" }),
  );

  // Horizontal ST depression maximal V1–V3 (the key STE-equivalent finding)
  let stAnt = 0;
  if (tt > qrsMu + 0.035 && tt < 0.72) {
    const u = (tt - (qrsMu + 0.035)) / (0.72 - (qrsMu + 0.035));
    // Flat/horizontal plateau rather than deep scooped ischemia
    stAnt = u < 0.2 ? -0.48 * (u / 0.2) : u > 0.85 ? -0.48 * (1 - (u - 0.85) / 0.15) : -0.48;
  }
  leads = addLeads(
    leads,
    scaleLeads(stAnt, {
      V1: 1.05,
      V2: 1.2,
      V3: 0.95,
      V4: 0.25,
      I: 0.08,
      aVL: 0.1,
    }, { precordial: "local" }),
  );
  // Subtle inferior STE (common partner territory) — opposite sign, small amp
  let stInf = 0;
  if (tt > qrsMu + 0.035 && tt < 0.72) {
    const u = (tt - (qrsMu + 0.035)) / 0.55;
    stInf = 0.18 * (u < 0.25 ? u / 0.25 : 1 - 0.2 * Math.max(0, u - 0.25));
  }
  leads = addLeads(
    leads,
    scaleLeads(stInf, {
      II: 0.85,
      III: 1.0,
      aVF: 0.9,
      V5: 0.2,
      V6: 0.25,
    }),
  );

  // Tall upright T V1–V2 (acute posterior); milder upright inferior T
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, tMu, 0.07, 0.7), {
      V1: 1.05,
      V2: 1.15,
      V3: 0.45,
      II: 0.35,
      III: 0.4,
      aVF: 0.35,
      V5: 0.2,
      V6: 0.2,
    }, { precordial: "local" }),
  );

  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.4, phase: "Tall R V1–V2 · posterior Q mirror", active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: 0.55, phase: "Horizontal STD V1–V3 · posterior STE equivalent", active: ["myocardiumV"], mark: "ST" },
      { start: 0.55, end: 0.78, phase: "Tall upright T V1–V2 · acute posterior", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleStemiAvr(t: number): WaveSample {
  return sampleStemiTerritory(t, {
    stAmp: 0.48,
    tAmp: 0.25,
    stW: {
      I: -0.55,
      II: -0.7,
      III: -0.45,
      aVR: 1.15,
      aVL: -0.35,
      aVF: -0.55,
      V1: 0.35,
      V2: -0.45,
      V3: -0.65,
      V4: -0.75,
      V5: -0.7,
      V6: -0.55,
    },
    tW: {
      aVR: 0.7,
      I: -0.35,
      II: -0.4,
      V3: -0.4,
      V4: -0.45,
      V5: -0.4,
    },
    qrsDetail: "QRS · severe ischemia context",
    stDetail: "STE aVR · diffuse ST depression · LMCA / 3VD cue",
    tDetail: "Ischemic T-wave changes",
  });
}

function sampleDewinter(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const tMu = 0.58;
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, qrsLeads(tt, qrsMu, 0.026, 0.95, -0.04, -0.15));

  // Upsloping J-point / ST depression into tall peaked T (De Winter)
  let jDep = 0;
  if (tt > qrsMu + 0.02 && tt < tMu + 0.02) {
    const u = (tt - (qrsMu + 0.02)) / (tMu - qrsMu);
    jDep = -0.38 * (1 - u) - 0.08 * Math.sin(u * Math.PI);
  }
  leads = addLeads(
    leads,
    scaleLeads(
      jDep,
      { V1: 0.35, V2: 1.0, V3: 1.15, V4: 1.05, V5: 0.45, I: 0.15, aVL: 0.2 },
      { precordial: "local" },
    ),
  );
  // Hyperacute symmetric peaked T
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, tMu, 0.055, 0.95),
      { V1: 0.45, V2: 1.15, V3: 1.25, V4: 1.1, V5: 0.5, I: 0.2, aVL: 0.25 },
      { precordial: "local" },
    ),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.4, phase: "Narrow QRS · De Winter pattern", active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: 0.52, phase: "Upsloping ST depression V2–V4", active: ["myocardiumV"], mark: "ST" },
      { start: 0.52, end: 0.75, phase: "Hyperacute peaked T · LAD equivalent", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleWellens(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const tMu = 0.6;
  let leads = pWaveLeads(tt, 0.1);
  // Preserved R-wave progression (pain-free Wellens)
  leads = addLeads(leads, qrsLeads(tt, qrsMu, 0.026, 0.95, -0.03, -0.12));
  // Near-isoelectric ST
  let st = 0;
  if (tt > qrsMu + 0.03 && tt < 0.55) st = 0.04;
  leads = addLeads(
    leads,
    scaleLeads(st, { V2: 0.6, V3: 0.7, V4: 0.3 }, { precordial: "local" }),
  );
  // Type A: biphasic T V2–V3 (up then deep down) + deep inverted V3–V4
  const biphasic =
    gauss(tt, tMu - 0.04, 0.03, 0.22) + gauss(tt, tMu + 0.05, 0.055, -0.85);
  leads = addLeads(
    leads,
    scaleLeads(
      biphasic,
      { V1: 0.25, V2: 1.1, V3: 1.2, V4: 0.75, V5: 0.25, I: 0.1, aVL: 0.15 },
      { precordial: "local" },
    ),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.4, phase: "Preserved R waves · Wellens", active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: 0.52, phase: "Isoelectric / minimally elevated ST", active: ["myocardiumV"], mark: "ST" },
      { start: 0.52, end: 0.78, phase: "Biphasic / deep inverted T V2–V3 · critical LAD", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleSgarbossa(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.34;
  let leads = pWaveLeads(tt, 0.1, 0.14);

  /**
   * Sgarbossa (STEMI with LBBB) — teaching strip:
   * 1) Concordant STE ≥1 mm in leads with positive QRS (I · aVL · V5–V6) — most specific
   * 2) Excessive discordant STE in V1–V3 (beyond usual LBBB secondary change)
   * Base QRS from the same LBBB morphology used elsewhere so it reads as true LBBB.
   */
  leads = addLeads(leads, lbbbMorphQrs(tt, qrsMu, 1.0));

  // ST plateau window after wide QRS
  let st = 0;
  if (tt > qrsMu + 0.07 && tt < 0.72) {
    const u = (tt - (qrsMu + 0.07)) / (0.72 - (qrsMu + 0.07));
    st = u < 0.18 ? u / 0.18 : u > 0.88 ? (1 - u) / 0.12 : 1;
  }

  // Concordant STE in positive-QRS leads (overrides the usual discordant STD of LBBB)
  leads = addLeads(
    leads,
    scaleLeads(0.58 * st, {
      I: 1.0,
      aVL: 1.05,
      V4: 0.35,
      V5: 1.1,
      V6: 1.15,
      II: 0.3,
    }, { precordial: "local" }),
  );

  // Excessive discordant STE in negative-QRS leads (V1–V3) — larger than secondary LBBB STE
  leads = addLeads(
    leads,
    scaleLeads(0.62 * st, {
      V1: 1.05,
      V2: 1.15,
      V3: 0.75,
    }, { precordial: "local" }),
  );

  // Secondary discordant T (appropriate for LBBB): upright right precordial, inverted lateral
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.66, 0.055, 0.4), {
      I: -0.65,
      II: -0.35,
      III: 0.15,
      aVR: 0.45,
      aVL: -0.6,
      aVF: -0.15,
      V1: 0.8,
      V2: 0.7,
      V3: 0.3,
      V4: -0.25,
      V5: -0.65,
      V6: -0.75,
    }, { precordial: "local" }),
  );

  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.42, phase: "Wide LBBB morphology", active: ["rbb", "purkinjeR", "lbb", "lbba", "lbbp", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.42, end: 0.56, phase: "Concordant STE I/aVL/V5–V6 · excessive discordant STE V1–V3", active: ["myocardiumV"], mark: "ST" },
      { start: 0.56, end: 0.8, phase: "Discordant T waves · Sgarbossa-positive LBBB", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedAtrial(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = paceSpike(tt, 0.08, 0.5);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.2));
  leads = addLeads(leads, qrsLeads(tt, 0.34));
  leads = addLeads(leads, tWaveLeads(tt, 0.6));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.1, phase: "Atrial pacing spike", active: [], mark: "P" },
      { start: 0.1, end: 0.18, phase: "Captured P wave", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.18, end: 0.3, phase: "AV conduction", active: ["av"], mark: "PR" },
      { start: 0.3, end: 0.42, phase: "Narrow QRS", active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.42, end: 0.52, phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: 0.52, end: 0.72, phase: "T wave", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedVentricular(t: number): WaveSample {
  const tt = clamp01(t);
  const spikeT = 0.22;
  const qrsMu = 0.3;
  const qrsEnd = Math.min(0.72, qrsMu + mapQrsSec(0.16) / mapCycleSec + 0.04);
  let leads = paceSpike(tt, spikeT, 0.6);
  leads = addLeads(leads, pacedQrsLeads(tt, qrsMu, 1.0));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, Math.min(0.78, qrsEnd + 0.14), 0.055, 0.32), {
      I: -0.7,
      II: -0.35,
      III: 0.25,
      aVR: 0.5,
      aVL: -0.6,
      aVF: -0.1,
      V1: 0.75,
      V2: 0.65,
      V3: 0.2,
      V4: -0.35,
      V5: -0.7,
      V6: -0.8,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.2, end: 0.24, phase: "Ventricular pacing spike", active: [], mark: "QRS" },
      { start: 0.24, end: qrsEnd, phase: "Captured wide QRS (LBBB-like)", active: ["purkinjeR", "purkinjeL", "rbb", "myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: Math.min(0.85, qrsEnd + 0.1), phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: Math.min(0.85, qrsEnd + 0.1), end: 0.95, phase: "Discordant T", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedDual(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.36;
  const qrsEnd = Math.min(0.72, qrsMu + mapQrsSec(0.15) / mapCycleSec + 0.04);
  let leads = paceSpike(tt, 0.08, 0.45);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.16));
  leads = addLeads(leads, paceSpike(tt, 0.28, 0.55));
  leads = addLeads(leads, pacedQrsLeads(tt, qrsMu, 0.95));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, Math.min(0.8, qrsEnd + 0.14), 0.05, 0.3), {
      I: -0.65,
      II: -0.3,
      III: 0.2,
      aVR: 0.45,
      aVL: -0.55,
      aVF: -0.05,
      V1: 0.7,
      V2: 0.6,
      V3: 0.15,
      V4: -0.3,
      V5: -0.65,
      V6: -0.75,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.11, phase: "Atrial pacing spike · RA lead", active: ["sa", "myocardiumA"], mark: "P" },
      { start: 0.11, end: 0.26, phase: "Captured P · atrial myocardial field", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.26, end: 0.28, phase: "AV delay (paced)", active: ["av", "myocardiumA"], mark: "PR" },
      { start: 0.28, end: 0.32, phase: "Ventricular pacing spike · RV apical", active: [], mark: "QRS" },
      { start: 0.32, end: qrsEnd, phase: "Captured wide QRS", active: ["purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.95, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedRvSeptal(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.34;
  const qrsEnd = Math.min(0.7, qrsMu + mapQrsSec(0.13) / mapCycleSec + 0.04);
  let leads = paceSpike(tt, 0.08, 0.4);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.16));
  leads = addLeads(leads, paceSpike(tt, 0.27, 0.55));
  leads = addLeads(leads, pacedQrsLeads(tt, qrsMu, 0.88));
  leads = addLeads(leads, tWaveLeads(tt, Math.min(0.72, qrsEnd + 0.14), 0.26, 0.045));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.11, phase: "Atrial pacing spike · RA", active: ["sa", "myocardiumA"], mark: "P" },
      { start: 0.11, end: 0.2, phase: "Captured P", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.2, end: 0.27, phase: "AV delay", active: ["av"], mark: "PR" },
      { start: 0.27, end: 0.31, phase: "RV septal pacing spike", active: [], mark: "QRS" },
      { start: 0.31, end: qrsEnd, phase: "Septal myocardial capture · moderately wide QRS", active: ["rbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.95, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedRvot(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.34;
  const qrsEnd = Math.min(0.7, qrsMu + mapQrsSec(0.13) / mapCycleSec + 0.04);
  let leads = paceSpike(tt, 0.08, 0.4);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.16));
  leads = addLeads(leads, paceSpike(tt, 0.27, 0.55));
  leads = addLeads(leads, pacedRvotQrsLeads(tt, qrsMu, 0.9));
  leads = addLeads(leads, tWaveLeads(tt, Math.min(0.72, qrsEnd + 0.14), 0.26, 0.045));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.11, phase: "Atrial pacing spike · RA", active: ["sa", "myocardiumA"], mark: "P" },
      { start: 0.11, end: 0.2, phase: "Captured P", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.2, end: 0.27, phase: "AV delay", active: ["av"], mark: "PR" },
      { start: 0.27, end: 0.31, phase: "RVOT pacing spike", active: [], mark: "QRS" },
      { start: 0.31, end: qrsEnd, phase: "RVOT myocardial capture · inferior-axis QRS", active: ["rbb", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.95, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedHis(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.34;
  const qrsEnd = Math.min(0.62, qrsMu + mapQrsSec(0.09) / mapCycleSec + 0.04);
  let leads = paceSpike(tt, 0.08, 0.4);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.16));
  leads = addLeads(leads, paceSpike(tt, 0.26, 0.5));
  leads = addLeads(leads, qrsLeads(tt, qrsMu, 0.024 * (mapQrsSec(0.09) / 0.09), 1.0));
  leads = addLeads(leads, tWaveLeads(tt, 0.58, 0.26, 0.045));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.11, phase: "Atrial pacing spike · RA", active: ["sa", "myocardiumA"], mark: "P" },
      { start: 0.11, end: 0.2, phase: "Captured P", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.2, end: 0.26, phase: "AV delay", active: ["av"], mark: "PR" },
      { start: 0.26, end: 0.3, phase: "His-bundle pacing spike", active: [], mark: "QRS" },
      { start: 0.3, end: qrsEnd, phase: "His capture · near-physiologic QRS", active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.95, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedLbap(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.34;
  const qrsEnd = Math.min(0.64, qrsMu + mapQrsSec(0.1) / mapCycleSec + 0.04);
  let leads = paceSpike(tt, 0.08, 0.4);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.16));
  leads = addLeads(leads, paceSpike(tt, 0.26, 0.5));
  // Narrower than RV apical — conduction-system capture after spike
  leads = addLeads(leads, qrsLeads(tt, qrsMu, 0.026 * (mapQrsSec(0.1) / 0.1), 1.05));
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.36, 0.02, 0.15), { V1: -0.2, I: 0.15, V6: 0.2 }));
  leads = addLeads(leads, tWaveLeads(tt, 0.6, 0.26, 0.045));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.11, phase: "Atrial pacing spike · RA", active: ["sa", "myocardiumA"], mark: "P" },
      { start: 0.11, end: 0.2, phase: "Captured P", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.2, end: 0.26, phase: "AV delay", active: ["av"], mark: "PR" },
      { start: 0.26, end: 0.3, phase: "LBAP spike · left bundle area", active: [], mark: "QRS" },
      { start: 0.3, end: qrsEnd, phase: "Physiologic / narrow QRS", active: ["lbb", "lbba", "lbbp", "rbb", "purkinjeL", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.95, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedBiv(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.34;
  const qrsEnd = Math.min(0.68, qrsMu + mapQrsSec(0.12) / mapCycleSec + 0.04);
  let leads = paceSpike(tt, 0.08, 0.4);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.15));
  leads = addLeads(leads, paceSpike(tt, 0.27, 0.55));
  // Fusion QRS — after BiV spike
  leads = addLeads(leads, pacedQrsLeads(tt, qrsMu, 0.7));
  leads = addLeads(leads, qrsLeads(tt, 0.36, 0.022, 0.45));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, Math.min(0.78, qrsEnd + 0.12), 0.05, 0.22), {
      I: -0.35,
      II: -0.15,
      V1: 0.4,
      V6: -0.4,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.11, phase: "Atrial pacing spike · RA", active: ["sa", "myocardiumA"], mark: "P" },
      { start: 0.11, end: 0.2, phase: "Captured P", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.2, end: 0.27, phase: "AV delay", active: ["av"], mark: "PR" },
      { start: 0.27, end: 0.31, phase: "BiV spike · RV + LV (CS)", active: [], mark: "QRS" },
      { start: 0.31, end: qrsEnd, phase: "Fusion QRS · CRT capture", active: ["purkinjeR", "purkinjeL", "rbb", "lbb", "myocardiumV"], mark: "QRS" },
      { start: qrsEnd, end: 0.95, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleFailureToPace(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 2.4;
  const s = paperScale(CYCLE);
  const vtS = 0.4 / CYCLE;
  let leads = emptyLeads();
  leads = addLeads(leads, paceSpike(tt, nrm(0.2, CYCLE), 0.55));
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, nrm(0.28, CYCLE) - 0.02 * vtS, 0.022 * vtS, -0.08) +
        gauss(tt, nrm(0.28, CYCLE) + 0.02 * vtS, 0.05 * vtS, 0.9) +
        gauss(tt, nrm(0.28, CYCLE) + 0.08 * vtS, 0.04 * vtS, -0.28),
      {
        I: 0.95,
        II: 0.45,
        III: -0.35,
        aVR: -0.65,
        aVL: 0.9,
        aVF: 0.05,
        V1: -1.05,
        V2: -0.95,
        V3: -0.25,
        V4: 0.55,
        V5: 0.95,
        V6: 1.05,
      },
    ),
  );
  leads = addLeads(leads, tWaveLeads(tt, nrm(0.55, CYCLE), -0.25, 0.045 * s));
  // Expected pace ~1.1 s — absent — escape ~2.0 s
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, nrm(2.0, CYCLE) - 0.04 * vtS, 0.03 * vtS, -0.15) +
        gauss(tt, nrm(2.0, CYCLE), 0.055 * vtS, 0.75) +
        gauss(tt, nrm(2.0, CYCLE) + 0.06 * vtS, 0.04 * vtS, -0.35) +
        gauss(tt, nrm(2.0, CYCLE) + 0.1 * vtS, 0.03 * vtS, 0.25),
      {
        I: -0.55,
        II: -0.85,
        III: -0.7,
        aVR: 0.7,
        aVL: -0.2,
        aVF: -0.8,
        V1: 1.1,
        V2: 0.9,
        V3: 0.2,
        V4: -0.55,
        V5: -0.85,
        V6: -0.9,
      },
    ),
  );
  leads = addLeads(leads, tWaveLeads(tt, nrm(2.25, CYCLE), -0.18, 0.04 * s));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Output failure · no spike",
    active: [],
    mark: "TP",
  };
  if (tt < nrm(0.35, CYCLE)) meta = { phase: "Ventricular pacing spike", active: ["myocardiumV"], mark: "QRS" };
  else if (tt < nrm(0.7, CYCLE)) meta = { phase: "Captured paced QRS", active: ["purkinjeR", "myocardiumV"], mark: "QRS" };
  else if (tt < nrm(1.2, CYCLE)) meta = { phase: "Expected pace — no output", active: [], mark: "TP" };
  else if (tt < nrm(1.9, CYCLE)) meta = { phase: "Asystolic pause", active: [], mark: "TP" };
  else meta = { phase: "Escape beat", active: ["purkinjeL", "myocardiumV"], mark: "QRS" };
  return pack(leads, meta);
}

function sampleFailureToCapture(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 2.2;
  const s = paperScale(CYCLE);
  const vtS = 0.4 / CYCLE;
  let leads = emptyLeads();
  for (const sec of [0.25, 0.85, 1.45]) {
    leads = addLeads(leads, paceSpike(tt, nrm(sec, CYCLE), 0.6));
  }
  const cap = nrm(1.55, CYCLE);
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, cap - 0.02 * vtS, 0.022 * vtS, -0.08) +
        gauss(tt, cap + 0.02 * vtS, 0.05 * vtS, 0.95) +
        gauss(tt, cap + 0.08 * vtS, 0.04 * vtS, -0.28),
      {
        I: 0.95,
        II: 0.45,
        III: -0.35,
        aVR: -0.65,
        aVL: 0.9,
        aVF: 0.05,
        V1: -1.05,
        V2: -0.95,
        V3: -0.25,
        V4: 0.55,
        V5: 0.95,
        V6: 1.05,
      },
    ),
  );
  leads = addLeads(leads, tWaveLeads(tt, nrm(1.9, CYCLE), -0.28, 0.04 * s));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Failure to capture",
    active: [],
    mark: "TP",
  };
  if ([0.25, 0.85, 1.45].some((sec) => Math.abs(tt - nrm(sec, CYCLE)) < 0.04 * s + 0.01)) {
    meta = { phase: "Pacing spike · no capture", active: [], mark: "TP" };
  }
  if (tt >= nrm(1.5, CYCLE) && tt < nrm(1.85, CYCLE)) {
    meta = { phase: "Spike with capture", active: ["purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" };
  } else if (tt >= nrm(1.85, CYCLE) && tt < nrm(2.1, CYCLE)) {
    meta = { phase: "Captured T wave", active: ["myocardiumV"], mark: "T" };
  }
  return pack(leads, meta);
}

function sampleFailureToSense(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 2.0;
  const s = paperScale(CYCLE);
  const vtS = 0.4 / CYCLE;
  let leads = addLeads(
    addLeads(pWaveLeads(tt, nrm(0.12, CYCLE), 0.18, 0.025 * s), qrsLeads(tt, nrm(0.28, CYCLE), 0.028 * s)),
    tWaveLeads(tt, nrm(0.55, CYCLE), 0.28, 0.04 * s),
  );
  leads = addLeads(leads, paceSpike(tt, nrm(0.7, CYCLE), 0.65));
  const paced = nrm(0.78, CYCLE);
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, paced - 0.02 * vtS, 0.022 * vtS, -0.08) +
        gauss(tt, paced + 0.02 * vtS, 0.05 * vtS, 0.85) +
        gauss(tt, paced + 0.08 * vtS, 0.04 * vtS, -0.28),
      {
        I: 0.95,
        II: 0.45,
        III: -0.35,
        aVR: -0.65,
        aVL: 0.9,
        aVF: 0.05,
        V1: -1.05,
        V2: -0.95,
        V3: -0.25,
        V4: 0.55,
        V5: 0.95,
        V6: 1.05,
      },
    ),
  );
  leads = addLeads(leads, tWaveLeads(tt, nrm(1.15, CYCLE), -0.3, 0.045 * s));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Undersensing", active: [], mark: "TP" };
  if (tt < nrm(0.2, CYCLE)) meta = { phase: "Intrinsic P", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  else if (tt < nrm(0.45, CYCLE)) {
    meta = {
      phase: "Intrinsic QRS (not sensed)",
      active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
      mark: "QRS",
    };
  } else if (tt < nrm(0.75, CYCLE)) meta = { phase: "Inappropriate pacing spike", active: [], mark: "QRS" };
  else if (tt < nrm(1.05, CYCLE)) meta = { phase: "Paced QRS after undersense", active: ["myocardiumV", "purkinjeR"], mark: "QRS" };
  else meta = { phase: "Repolarization", active: ["myocardiumV"], mark: "T" };
  return pack(leads, meta);
}

function sampleSinusPause(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 3.0;
  const s = paperScale(CYCLE);
  let leads = emptyLeads();
  // Two sinus beats (PP ~0.85 s), pause ~1.2 s (not 2×), junctional escape
  for (const pSec of [0.1, 0.95]) {
    const p = nrm(pSec, CYCLE);
    leads = addLeads(leads, addLeads(pWaveLeads(tt, p, 0.18, 0.025 * s), qrsLeads(tt, nrm(pSec + 0.16, CYCLE), 0.028 * s)));
    leads = addLeads(leads, tWaveLeads(tt, nrm(pSec + 0.4, CYCLE), 0.24, 0.035 * s));
  }
  leads = addLeads(leads, qrsLeads(tt, nrm(2.35, CYCLE), 0.026 * s, 0.75));
  leads = addLeads(leads, tWaveLeads(tt, nrm(2.65, CYCLE), 0.2, 0.03 * s));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Sinus pause", active: [], mark: "TP" };
  if (tt < nrm(1.3, CYCLE)) {
    if ([0.1, 0.95].some((p) => Math.abs(tt - nrm(p, CYCLE)) < 0.06 * s + 0.01)) {
      meta = { phase: "Sinus P–QRS", active: ["sa", "internodal", "av", "his", "myocardiumV"], mark: "P" };
    } else meta = { phase: "Sinus rhythm", active: ["myocardiumV"], mark: "T" };
  } else if (tt < nrm(2.25, CYCLE)) meta = { phase: "Sinus pause / arrest · no P", active: [], mark: "TP" };
  else meta = { phase: "Escape beat", active: ["av", "his", "purkinjeL", "myocardiumV"], mark: "QRS" };
  return pack(leads, meta);
}

function sampleSaExitBlock(t: number): WaveSample {
  const tt = clamp01(t);
  /** PP 0.80 s · dropped beat → pause 1.60 s (= 2× PP) · 4 expected slots */
  const CYCLE = 3.2;
  const s = paperScale(CYCLE);
  const beats = [0.1, 0.9, /* drop at 1.7 */ 2.5];
  let leads = emptyLeads();
  for (const pSec of beats) {
    const p = nrm(pSec, CYCLE);
    leads = addLeads(leads, addLeads(pWaveLeads(tt, p, 0.18, 0.025 * s), qrsLeads(tt, nrm(pSec + 0.16, CYCLE), 0.028 * s)));
    leads = addLeads(leads, tWaveLeads(tt, nrm(pSec + 0.4, CYCLE), 0.22, 0.03 * s));
  }
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "SA exit block",
    active: [],
    mark: "TP",
  };
  for (const pSec of beats) {
    if (Math.abs(tt - nrm(pSec, CYCLE)) < 0.05 * s + 0.01) {
      meta = { phase: "Sinus P–QRS", active: ["sa", "internodal", "av", "his", "myocardiumV"], mark: "P" };
    }
  }
  if (tt > nrm(1.5, CYCLE) && tt < nrm(2.4, CYCLE)) {
    meta = { phase: "Dropped beat · pause ≈ 2× PP", active: ["sa"], mark: "TP" };
  }
  return pack(leads, meta);
}

function sampleSickSinus(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 3.2;
  const s = paperScale(CYCLE);
  let leads = emptyLeads();

  // Inappropriate sinus brady (PP ~1.1 s) → arrest → junctional escape → slow P
  for (const pSec of [0.12, 1.22]) {
    const p = nrm(pSec, CYCLE);
    leads = addLeads(leads, pWaveLeads(tt, p, 0.15, 0.025 * s));
    leads = addLeads(leads, qrsLeads(tt, nrm(pSec + 0.16, CYCLE), 0.024 * s, 0.9));
    leads = addLeads(leads, tWaveLeads(tt, nrm(pSec + 0.4, CYCLE), 0.24, 0.035 * s));
  }
  leads = addLeads(leads, qrsLeads(tt, nrm(2.55, CYCLE), 0.024 * s, 0.7, -0.04, -0.12));
  leads = addLeads(leads, tWaveLeads(tt, nrm(2.85, CYCLE), 0.2, 0.035 * s));
  leads = addLeads(leads, pWaveLeads(tt, nrm(3.05, CYCLE), 0.12, 0.025 * s));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Sick sinus syndrome",
    active: [],
    mark: "TP",
  };
  if (tt < nrm(1.7, CYCLE)) {
    if ([0.12, 1.22].some((p) => Math.abs(tt - nrm(p, CYCLE)) < 0.05 * s + 0.01)) {
      meta = { phase: "Inappropriate sinus bradycardia", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    } else if ([0.28, 1.38].some((q) => Math.abs(tt - nrm(q, CYCLE)) < 0.05 * s + 0.01)) {
      meta = {
        phase: "Conducted QRS",
        active: ["av", "his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      };
    } else {
      meta = { phase: "Slow sinus rhythm (SSS)", active: ["sa"], mark: "TP" };
    }
  } else if (tt < nrm(2.45, CYCLE)) {
    meta = { phase: "Sinus arrest · no P waves", active: [], mark: "TP" };
  } else if (tt < nrm(2.95, CYCLE)) {
    meta = { phase: "Junctional escape", active: ["av", "his", "purkinjeL", "myocardiumV"], mark: "QRS" };
  } else {
    meta = { phase: "Slow sinus recovery", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  }
  return pack(leads, meta);
}

function sampleTachyBrady(t: number): WaveSample {
  const tt = clamp01(t);
  const CYCLE = 3.2;
  const s = paperScale(CYCLE);
  let leads = emptyLeads();
  if (tt < nrm(1.2, CYCLE)) {
    addAfibFwaves(leads, tt, 0.9);
    for (const bSec of [0.15, 0.4, 0.62, 0.95]) {
      leads = addLeads(leads, qrsLeads(tt, nrm(bSec, CYCLE), 0.02 * s, 0.85));
    }
  }
  if (tt > nrm(2.4, CYCLE)) {
    leads = addLeads(
      leads,
      addLeads(pWaveLeads(tt, nrm(2.5, CYCLE), 0.14, 0.025 * s), qrsLeads(tt, nrm(2.9, CYCLE), 0.022 * s, 0.7)),
    );
  }

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Tachy–brady syndrome",
    active: [],
    mark: "TP",
  };
  if (tt < nrm(1.2, CYCLE)) {
    meta = {
      phase: "Atrial tachyarrhythmia burst",
      active: ["myocardiumA", "av", "his", "myocardiumV"],
      mark: tt < nrm(1.1, CYCLE) && (tt * 20) % 1 < 0.4 ? "QRS" : "TP",
    };
  } else if (tt < nrm(2.4, CYCLE)) meta = { phase: "Post-conversion sinus pause", active: [], mark: "TP" };
  else meta = { phase: "Slow sinus recovery", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  return pack(leads, meta);
}

const SAMPLERS: Record<FindingId, (t: number) => WaveSample> = {
  nsr: sampleNsr,
  sinusBrady: sampleBrady,
  sinusTachy: sampleTachy,
  afib: sampleAfib,
  aflutterCcw: sampleAflutterCcw,
  aflutterCw: sampleAflutterCw,
  avnrtTypical: sampleAvnrtTypical,
  avnrtAtypical: sampleAvnrtAtypical,
  avrtOrthoLeft: (t) => sampleAvrtOrtho(t, "left"),
  avrtOrthoRight: (t) => sampleAvrtOrtho(t, "right"),
  avrtAntiLeft: (t) => sampleAvrtAnti(t, "left"),
  avrtAntiRight: (t) => sampleAvrtAnti(t, "right"),
  av1: sampleAv1,
  av2i: sampleAv2i,
  av2ii: sampleAv2ii,
  av3: sampleAv3,
  av3Junctional: sampleAv3Junctional,
  rbbb: sampleRbbb,
  lbbb: sampleLbbb,
  lafb: sampleLafb,
  lpfb: sampleLpfb,
  rbbbLafb: sampleRbbbLafb,
  rbbbLpfb: sampleRbbbLpfb,
  pac: samplePac,
  pvc: samplePvc,
  vt: sampleVt,
  vtMonoLbbb: sampleVtMonoLbbb,
  vtMonoRbbb: sampleVtMonoRbbb,
  vtPoly: sampleVtPoly,
  torsades: sampleTorsades,
  vfCoarse: sampleVfCoarse,
  vfFine: sampleVfFine,
  asystole: sampleAsystole,
  stemiAnt: sampleStemi,
  stemiInferior: sampleStemiInferior,
  stemiLateral: sampleStemiLateral,
  stemiAnterolateral: sampleStemiAnterolateral,
  stemiPosterior: sampleStemiPosterior,
  stemiAvr: sampleStemiAvr,
  dewinter: sampleDewinter,
  wellens: sampleWellens,
  sgarbossa: sampleSgarbossa,
  pacedAtrial: samplePacedAtrial,
  pacedVentricular: samplePacedVentricular,
  pacedDual: samplePacedDual,
  pacedRvSeptal: samplePacedRvSeptal,
  pacedRvot: samplePacedRvot,
  pacedHis: samplePacedHis,
  pacedLbap: samplePacedLbap,
  pacedBiv: samplePacedBiv,
  failureToPace: sampleFailureToPace,
  failureToCapture: sampleFailureToCapture,
  failureToSense: sampleFailureToSense,
  sinusPause: sampleSinusPause,
  saExitBlock: sampleSaExitBlock,
  sickSinus: sampleSickSinus,
  tachyBrady: sampleTachyBrady,
};

function smoothstep(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
}

function lerpWaveSample(a: WaveSample, b: WaveSample, u: number): WaveSample {
  const w = Math.max(0, Math.min(1, u));
  const leads = emptyLeads();
  for (const lead of LEADS) {
    leads[lead] = a.leads[lead]! * (1 - w) + b.leads[lead]! * w;
  }
  const src = w < 0.45 ? a : b;
  return pack(leads, { phase: src.phase, active: src.active, mark: src.mark });
}

/** Suggested wall-clock length for post-shock recovery (5–8 s). */
export function cardioversionDurationSec(from: FindingId): number {
  if (from === "vfCoarse" || from === "vfFine" || from === "torsades") return 7.8;
  if (from === "vt" || from === "vtMonoLbbb" || from === "vtMonoRbbb" || from === "vtPoly") return 7.2;
  if (from === "afib" || from === "aflutterCcw" || from === "aflutterCw") return 6.8;
  if (from === "avnrtTypical" || from === "avnrtAtypical" || from === "avrtOrthoLeft" || from === "avrtOrthoRight" || from === "avrtAntiLeft" || from === "avrtAntiRight" || from === "sinusTachy") return 6.4;
  if (from === "asystole") return 5.5;
  return 6.2;
}

/**
 * Continuous post-shock recovery → target rhythm.
 * Early strip is decaying fine-VF residual (chaotic undulations only — no discrete
 * QRS / VT-like escapes), then crossfades into the chosen finding.
 * `t` is normalized over the recovery window (0…1).
 */
export function samplePostCardioversion(
  t: number,
  from: FindingId,
  to: FindingId = "nsr",
): WaveSample {
  const tt = Math.max(0, Math.min(1, t));
  let seed = 0;
  for (let i = 0; i < from.length; i++) seed = (seed * 33 + from.charCodeAt(i)) >>> 0;

  const wasShockableVent =
    from === "vfCoarse" ||
    from === "vfFine" ||
    from === "torsades" ||
    from === "vt" ||
    from === "vtMonoLbbb" ||
    from === "vtMonoRbbb" ||
    from === "vtPoly";
  const wasAf = from === "afib" || from === "aflutterCcw" || from === "aflutterCw";
  const toAsystole = to === "asystole";

  let leads = emptyLeads();
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Post-shock · electrical silence",
    active: [],
    mark: "TP",
  };

  // Tiny baseline stun
  const stun = 0.006 * Math.sin(tt * 55 + seed) * Math.exp(-tt * 5);
  leads = addLeads(leads, scaleLeads(stun, { II: 1, V1: 0.55, V5: 0.45 }));

  // Decaying fine-VF hash — keep a brief early bump, then messy irregular undulations
  // (no discrete QRS / organized VT morphology). Persist through more of the recovery window.
  const vfPeak = wasShockableVent ? 1.05 : wasAf ? 0.28 : 0.45;
  const earlyBump = Math.exp(-Math.pow((tt - 0.04) / 0.045, 2)) * 0.35;
  const vfEnv =
    vfPeak *
    (0.55 * (1 - smoothstep((tt - 0.08) / 0.72)) + earlyBump) *
    (tt < 0.01 ? smoothstep(tt / 0.01) : 1);

  if (vfEnv > 0.012 && !toAsystole) {
    // Drive chaos from continuous recovery time (not a looping phase) so it stays aperiodic
    const u = tt + (seed % 53) * 0.0017;
    const ax =
      -0.15 +
      0.55 * Math.sin(u * 17.3 + 0.4) +
      0.4 * Math.sin(u * 41.7 + 1.9) +
      0.25 * Math.sin(u * 73.1 + 0.7);
    const ay =
      -0.4 +
      0.5 * Math.cos(u * 13.1 + 0.2) +
      0.4 * Math.sin(u * 29.6 + 0.7) +
      0.22 * Math.cos(u * 61.4);
    const az =
      0.5 +
      0.45 * Math.sin(u * 19.7 + 2.1) +
      0.35 * Math.cos(u * 37.2) +
      0.2 * Math.sin(u * 88.5 + 1.1);
    const fibW = projectCardiacVector(1, { x: ax, y: ay, z: az });
    const fibW2 = projectCardiacVector(1, { x: -ay * 0.9, y: az * 0.75, z: ax * 0.55 });
    const fibW3 = projectCardiacVector(1, { x: az * 0.6, y: -ax * 0.7, z: -ay * 0.5 });
    const PHI = 1.6180339887;
    const strength = 1.25 * vfEnv;
    for (let i = 0; i < 22; i++) {
      const hSeed = i * 2.718281828 + 1.31 + (seed % 17) * 0.013;
      // Wide, incommensurate frequency set — looks hashy, not metronomic
      const freq = 11 + ((i * PHI * 5.3) % 34) + 4 * Math.sin(hSeed * 2.1);
      const freqJ =
        1 +
        0.55 * Math.sin(u * (9.1 + i * 0.71) + hSeed) +
        0.35 * Math.sin(u * (23.7 + i * 0.33) + hSeed * 1.9) +
        0.2 * Math.sin(u * (47.3 + i * 0.11) + hSeed * 0.4);
      const env =
        0.4 +
        0.35 * Math.sin(u * (7.3 + i * 0.41) + hSeed) * Math.sin(u * (15.9 + i * 0.27) + hSeed * 1.7) +
        0.3 * Math.sin(u * (31.2 + i * 0.17) + hSeed * 0.6) +
        0.2 * Math.abs(Math.sin(u * (53 + i * 0.09) + hSeed * 2.3));
      const amp = (0.04 + 0.032 * Math.abs(Math.sin(hSeed * 3.1))) * strength * Math.max(0.2, env);
      const ph = hSeed * 1.3 + u * (0.7 + 0.15 * i);
      const v =
        Math.sin((u * freq * freqJ + ph) * Math.PI * 2) * amp +
        Math.sin((u * freq * 1.732 * freqJ + ph * 0.6) * Math.PI * 2) * amp * 0.75 +
        Math.sin((u * freq * 0.31 * (1 + 0.5 * Math.sin(u * 11 + i)) + ph) * Math.PI * 2) * amp * 0.4 +
        Math.sin((u * freq * (PHI + 0.4) + ph * 2.1) * Math.PI * 2) * amp * 0.5 +
        Math.sin((u * (freq * 2.63 + i * 1.7) + ph * 0.3) * Math.PI * 2) * amp * 0.28;
      // Irregular dipole mix so lead polarity keeps flipping
      const m1 = 0.4 + 0.35 * Math.sin(u * (6.1 + i * 0.19) + hSeed);
      const m2 = 0.3 + 0.3 * Math.sin(u * (11.7 + i * 0.23) + hSeed * 1.4);
      const m3 = Math.max(0.05, 1 - m1 - m2);
      addInto(leads, scaleLeads(v * m1, fibW));
      addInto(leads, scaleLeads(v * m2, fibW2));
      addInto(leads, scaleLeads(v * m3 * 0.9, fibW3));
    }
    meta = {
      phase:
        vfEnv > 0.45
          ? "Post-shock · fine VF residual"
          : "Post-shock · fibrillatory residual decaying",
      active: ["myocardiumV"],
      mark: "TP",
    };
  } else if (tt < 0.7) {
    meta = { phase: "Post-shock asystole · myocardial stun", active: [], mark: "TP" };
  }

  if (wasAf && tt > 0.2 && tt < 0.6) {
    const fib =
      0.028 * (1 - smoothstep((tt - 0.2) / 0.4)) * Math.sin(tt * 130 + seed * 0.02);
    leads = addLeads(leads, scaleLeads(fib, { II: 1, V1: 1.15, aVF: 0.55 }));
  }

  if (toAsystole && tt > 0.12) {
    meta = { phase: "Persistent asystole · no escape", active: [], mark: "TP" };
  }

  const recovery: WaveSample = pack(leads, meta);

  // Crossfade into target after the VF residual has had time to run
  const targetAnchor = 0.62;
  const targetSpan = 1 - targetAnchor;
  const targetCycles = 1.85;
  const targetT =
    tt <= targetAnchor ? 0 : clamp01((((tt - targetAnchor) / targetSpan) * targetCycles) % 1);
  const target = sampleWave(to, targetT);
  const toLabel = to === "nsr" ? "sinus" : getFindingShort(to);
  const targetLabeled: WaveSample = {
    ...target,
    phase:
      tt < 0.82
        ? `Merging into ${toLabel} · ${target.phase}`
        : tt < 0.93
          ? `${toLabel} restoring · ${target.phase}`
          : target.phase,
  };

  const blend = smoothstep((tt - 0.68) / 0.26);
  if (blend <= 0.001) return recovery;
  if (blend >= 0.999) return targetLabeled;
  return lerpWaveSample(recovery, targetLabeled, blend);
}

function getFindingShort(id: FindingId): string {
  switch (id) {
    case "nsr":
      return "sinus";
    case "asystole":
      return "asystole";
    case "avnrtTypical":
    case "avnrtAtypical":
      return "AVNRT";
    case "avrtOrthoLeft":
    case "avrtOrthoRight":
    case "avrtAntiLeft":
    case "avrtAntiRight":
      return "AVRT";
    case "afib":
      return "AFib";
    case "sinusBrady":
      return "brady";
    case "sinusTachy":
      return "tachy";
    default:
      return id;
  }
}

/** Target-rhythm cycle phase at the end of a recovery window (seamless handoff). */
export function cardioversionEndTargetPhase(): number {
  const targetAnchor = 0.62;
  const targetSpan = 1 - targetAnchor;
  const targetCycles = 1.85;
  return clamp01(((((1 - targetAnchor) / targetSpan) * targetCycles) % 1));
}

/** @deprecated use cardioversionEndTargetPhase */
export function cardioversionEndNsrPhase(): number {
  return cardioversionEndTargetPhase();
}

  /** Absolute-time recovery / target phase for conduction + strip continuity.
   * `elapsedSec` is time since the shock (not wall-clock).
   */
export function cardioversionTCycle(
  elapsedSec: number,
  durationSec: number,
  targetCycleSec: number,
): number {
  const targetAnchor = 0.62;
  const targetSpan = 1 - targetAnchor;
  const targetCycles = 1.85;
  const cycle = Math.max(0.25, targetCycleSec);
  if (elapsedSec < durationSec) {
    const tt = Math.max(0, elapsedSec) / Math.max(0.001, durationSec);
    if (tt <= targetAnchor) return tt;
    return clamp01((((tt - targetAnchor) / targetSpan) * targetCycles) % 1);
  }
  const post = elapsedSec - durationSec;
  return clamp01(cardioversionEndTargetPhase() + post / cycle);
}

/** Wall-clock phase helper spanning pre-shock → recovery → target. */
export function cardioversionWallTCycle(
  elapsedSec: number,
  shockAtSec: number,
  durationSec: number,
  targetCycleSec: number,
  fromCycleSec: number,
): number {
  if (elapsedSec < shockAtSec) {
    const cycle = Math.max(0.25, fromCycleSec);
    return (((elapsedSec % cycle) + cycle) % cycle) / cycle;
  }
  return cardioversionTCycle(elapsedSec - shockAtSec, durationSec, targetCycleSec);
}

/**
 * Absolute-time cardioversion sampler.
 * Times before `shockAtSec` keep the prior rhythm so the rolling strip shows
 * the old morphology scrolling into the shock / recovery.
 */
export function sampleCardioversionAt(
  tAbs: number,
  from: FindingId,
  durationSec: number,
  targetCycleSec: number,
  to: FindingId = "nsr",
  shockAtSec = 0,
  fromCycleSec = 0.86,
): WaveSample {
  if (tAbs < shockAtSec) {
    const cycle = Math.max(0.25, fromCycleSec);
    const phase = (((tAbs % cycle) + cycle) % cycle) / cycle;
    return sampleWave(from, phase);
  }
  const post = tAbs - shockAtSec;
  if (post < durationSec) {
    return samplePostCardioversion(post / durationSec, from, to);
  }
  return sampleWave(to, cardioversionTCycle(post, durationSec, targetCycleSec));
}

export function sampleWave(id: FindingId, t: number): WaveSample {
  return SAMPLERS[id](clamp01(t));
}

/** Site used by stimulate-mode pacing */
export type StimSiteRef = {
  segmentId: SegmentId;
  curveIndex?: number;
  pathU: number;
  name: string;
  detail?: string;
};

function stimKind(id: SegmentId): "atrial" | "junctional" | "rightVent" | "leftVent" | "accessory" | "ventricular" {
  switch (id) {
    case "sa":
    case "internodal":
    case "myocardiumA":
    case "flutter":
      return "atrial";
    case "av":
    case "his":
    case "avnrtSlow":
    case "avnrtFast":
      return "junctional";
    case "rbb":
    case "purkinjeR":
      return "rightVent";
    case "lbb":
    case "lbba":
    case "lbbp":
    case "purkinjeL":
      return "leftVent";
    case "accessory":
    case "accessoryR":
      return "accessory";
    default:
      return "ventricular";
  }
}

/** EKG generated by pacing from a clicked conduction site */
export function sampleStimulated(site: StimSiteRef, t: number): WaveSample {
  const tt = clamp01(t);
  const kind = stimKind(site.segmentId);
  const spikeT = 0.12;
  const qrsT = kind === "atrial" ? 0.36 : kind === "junctional" ? 0.28 : 0.26;

  let leads = paceSpike(tt, spikeT, 0.55);

  if (kind === "atrial") {
    leads = addLeads(leads, pWaveLeads(tt, 0.16, 0.18));
    leads = addLeads(leads, qrsLeads(tt, qrsT, 0.024, 1.0));
    leads = addLeads(leads, tWaveLeads(tt, qrsT + 0.26, 0.28, 0.045));
    return pack(
      leads,
      phaseFor(tt, [
        { start: 0.08, end: 0.14, phase: `Pace spike · ${site.name}`, active: [site.segmentId, "myocardiumA"], mark: "P" },
        { start: 0.14, end: 0.22, phase: "Captured atrial depolarization", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
        { start: 0.22, end: 0.32, phase: "AV conduction", active: ["av"], mark: "PR" },
        { start: 0.32, end: 0.45, phase: "Narrow QRS", active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
        { start: 0.45, end: 0.55, phase: "ST", active: ["myocardiumV"], mark: "ST" },
        { start: 0.55, end: 0.75, phase: "T wave", active: ["myocardiumV"], mark: "T" },
      ]),
    );
  }

  if (kind === "junctional") {
    // Retrograde or absent P; narrow QRS
    leads = addLeads(leads, scaleLeads(gauss(tt, 0.34, 0.022, -0.1), NSR_P));
    leads = addLeads(leads, qrsLeads(tt, qrsT, 0.024, 0.95));
    leads = addLeads(leads, tWaveLeads(tt, qrsT + 0.24, 0.26, 0.04));
    return pack(
      leads,
      phaseFor(tt, [
        { start: 0.08, end: 0.15, phase: `Pace spike · ${site.name}`, active: [site.segmentId], mark: "QRS" },
        { start: 0.18, end: 0.4, phase: "Junctional / His capture · narrow QRS", active: ["av", "his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
        { start: 0.32, end: 0.42, phase: "Retrograde atrial activation", active: ["internodal", "myocardiumA"], mark: "P" },
        { start: 0.45, end: 0.75, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
      ]),
    );
  }

  if (kind === "accessory") {
    const delta =
      gauss(tt, 0.16, 0.025, 0.25) + gauss(tt, 0.22, 0.03, 0.5) + gauss(tt, 0.28, 0.028, 0.35);
    leads = addLeads(
      leads,
      scaleLeads(delta, {
        I: 0.7,
        II: 0.55,
        III: 0.2,
        aVR: -0.55,
        aVL: 0.5,
        aVF: 0.35,
        V1: 0.85,
        V2: 0.9,
        V3: 0.75,
        V4: 0.7,
        V5: 0.65,
        V6: 0.6,
      }),
    );
    leads = addLeads(leads, wideQrsLeads(tt, 0.32, 0.7));
    leads = addLeads(leads, tWaveLeads(tt, 0.58, -0.3, 0.05));
    return pack(
      leads,
      phaseFor(tt, [
        { start: 0.08, end: 0.15, phase: `Pace spike · ${site.name}`, active: ["accessory"], mark: "PR" },
        { start: 0.15, end: 0.42, phase: "Preexcited fusion QRS", active: ["accessory", "myocardiumV", "purkinjeL"], mark: "QRS" },
        { start: 0.42, end: 0.75, phase: "Secondary ST–T", active: ["myocardiumV"], mark: "T" },
      ]),
    );
  }

  // Ventricular morphologies
  if (kind === "rightVent") {
    leads = addLeads(leads, lbbbMorphQrs(tt, qrsT, 1.05));
    leads = addLeads(
      leads,
      scaleLeads(gauss(tt, qrsT + 0.35, 0.05, 0.35), {
        I: -0.65,
        II: -0.35,
        III: 0.25,
        aVR: 0.5,
        aVL: -0.55,
        aVF: -0.1,
        V1: 0.8,
        V2: 0.7,
        V3: 0.2,
        V4: -0.3,
        V5: -0.65,
        V6: -0.75,
      }),
    );
  } else if (kind === "leftVent") {
    leads = addLeads(leads, rbbbMorphQrs(tt, qrsT, 1.05));
    leads = addLeads(
      leads,
      scaleLeads(gauss(tt, qrsT + 0.35, 0.05, 0.32), {
        I: 0.35,
        II: 0.4,
        III: 0.3,
        aVR: -0.35,
        aVL: 0.15,
        aVF: 0.35,
        V1: -0.65,
        V2: -0.5,
        V3: -0.15,
        V4: 0.3,
        V5: 0.5,
        V6: 0.55,
      }),
    );
  } else {
    leads = addLeads(leads, pacedQrsLeads(tt, qrsT, 1.0));
    leads = addLeads(
      leads,
      scaleLeads(gauss(tt, qrsT + 0.34, 0.05, 0.3), {
        I: -0.65,
        II: -0.3,
        III: 0.2,
        aVR: 0.45,
        aVL: -0.55,
        aVF: -0.05,
        V1: 0.7,
        V2: 0.6,
        V3: 0.15,
        V4: -0.3,
        V5: -0.65,
        V6: -0.75,
      }),
    );
  }

  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.08, end: 0.15, phase: `Pace spike · ${site.name}`, active: [site.segmentId, "myocardiumV"], mark: "QRS" },
      {
        start: 0.15,
        end: 0.48,
        phase:
          kind === "rightVent"
            ? "RV capture · LBBB-like QRS"
            : kind === "leftVent"
              ? "LV capture · RBBB-like QRS"
              : "Ventricular capture · wide QRS",
        active: [site.segmentId, "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      },
      { start: 0.48, end: 0.58, phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: 0.58, end: 0.85, phase: "Discordant T", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}
