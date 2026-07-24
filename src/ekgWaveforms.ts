import type { FindingId, SegmentId } from "./findings";
import { leadsFromHintWeights, projectCardiacVector, vectorFromAxis } from "./leadAxes";

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
/** Terminal: rightward / posterior → S in V1–V2 */
const NSR_TERM = projectCardiacVector(1, { x: -0.2, y: -0.2, z: -0.95 });
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

/** RV-apical / LBBB-like paced QRS */
function pacedQrsLeads(t: number, mu: number, amp = 1.0): Record<LeadId, number> {
  const shape =
    gauss(t, mu - 0.02, 0.022, -0.08) +
    gauss(t, mu + 0.02, 0.05, amp) +
    gauss(t, mu + 0.08, 0.04, -0.28);
  // RV apical / LBBB-like: leftward · posterior (deep V1)
  return scaleLeads(shape, projectCardiacVector(1, { x: 0.95, y: 0.1, z: -0.9 }));
}

function lbbbMorphQrs(t: number, mu: number, amp = 1.0, cycleSec = 0.86): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  const shape =
    gauss(t, mu - abs(0.02), abs(0.022), -0.08) +
    gauss(t, mu + abs(0.02), abs(0.045), amp * 0.65) +
    gauss(t, mu + abs(0.065), abs(0.05), amp) +
    gauss(t, mu + abs(0.11), abs(0.032), -0.22);
  // LBBB: leftward / superior-ish · deep S in V1
  return scaleLeads(shape, projectCardiacVector(1, { x: 0.9, y: 0.15, z: -0.85 }));
}

function rbbbMorphQrs(t: number, mu: number, amp = 1.0, cycleSec = 0.86): Record<LeadId, number> {
  const abs = (sec: number) => sec / Math.max(0.25, cycleSec);
  const shape =
    gauss(t, mu - abs(0.02), abs(0.02), -0.12) +
    gauss(t, mu + abs(0.01), abs(0.028), amp * 0.5) +
    gauss(t, mu + abs(0.055), abs(0.038), amp) +
    gauss(t, mu + abs(0.1), abs(0.032), -0.28);
  // RBBB: late rightward / anterior · rsR′ V1
  return scaleLeads(shape, projectCardiacVector(1, { x: -0.4, y: -0.45, z: 1.05 }));
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
    { start: 0.34 + d, end: 0.42 + d, phase: "Purkinje · ventricular depolarization", active: ["purkinjeR", "purkinjeL", "myocardiumV", "rbb", "lbb", "lbba", "lbbp"], mark: "QRS" },
    { start: 0.42 + d, end: 0.5 + d, phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
    { start: 0.5 + d, end: 0.7 + d, phase: "Ventricular repolarization", active: ["myocardiumV"], mark: "T" },
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
    phase: "Fibrillatory atria · SA quiescent · no P waves",
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
        phase: "Irregular QRS · no preceding P · SA still silent",
        active: ["av", "his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV", "internodal", "myocardiumA"],
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

  return pack(leads, meta);
}

function sampleAflutter(t: number, dir: "ccw" | "cw"): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();

  /**
   * Typical CTI flutter on paper time:
   * Atrial F–F 0.20 s (300/min). 2:1 conduction → vent 150 bpm (R–R 0.40 s).
   * Pattern window = 2 R–R = 0.80 s (exactly 4 F waves + 2 QRS).
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
    const inf =
      u < 0.45
        ? 0.16 * Math.sin((u / 0.45) * Math.PI)
        : -0.06 * Math.sin(((u - 0.45) / 0.55) * Math.PI);
    leads = addLeads(
      leads,
      scaleLeads(inf, projectCardiacVector(1, { x: -0.15, y: 0.95, z: 0.05 })),
    );
    const mu = f0 + fIndex * period;
    const v1 = gauss(tt, mu + 0.055 * s, 0.03 * s, -0.14) + gauss(tt, mu + 0.13 * s, 0.02 * s, 0.04);
    leads = addLeads(
      leads,
      scaleLeads(v1, projectCardiacVector(1, { x: -0.1, y: 0.08, z: 0.9 })),
    );
  }

  const qrsTimes = [nrm(0.16, CYCLE), nrm(0.56, CYCLE)];
  const limbs = ["CTI", "septal ascending", "RA roof", "crista descending"] as const;
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
      const order = dir === "ccw" ? limb : 3 - limb;
      meta = {
        phase:
          dir === "ccw"
            ? `CCW typical · ${limbs[order]} · inferior − sawtooth`
            : `CW reverse · ${limbs[order]} · inferior + F waves`,
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
  const early: Partial<Record<LeadId, number>> = {
    I: 0.55,
    II: 0.7,
    III: 0.35,
    aVR: -0.5,
    aVL: 0.25,
    aVF: 0.55,
    V1: -0.35,
    V2: -0.25,
    V3: 0.25,
    V4: 0.7,
    V5: 0.75,
    V6: 0.65,
  };
  const lateR: Partial<Record<LeadId, number>> = {
    I: -0.45,
    II: -0.25,
    III: 0.15,
    aVR: 0.35,
    aVL: -0.4,
    aVF: -0.1,
    V1: 1.15,
    V2: 0.95,
    V3: 0.35,
    V4: -0.15,
    V5: -0.45,
    V6: -0.55,
  };
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.3, 0.018, -0.1) + gauss(tt, 0.325, 0.022, 0.7), early));
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.37, 0.028, -0.15) + gauss(tt, 0.41, 0.03, 0.55), lateR));
  leads = addLeads(
    leads,
    tWaveLeads(tt, 0.62, 0.28, 0.05, {
      I: 0.5,
      II: 0.6,
      III: 0.3,
      aVR: -0.4,
      aVL: 0.25,
      aVF: 0.45,
      V1: -0.55,
      V2: -0.45,
      V3: -0.1,
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
      { start: 0.28, end: 0.38, phase: "Left bundle first · LV (RBB blocked)", active: ["lbb", "lbba", "lbbp", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.38, end: 0.52, phase: "Transseptal → distal right / RV", active: ["rbb", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: 0.52, end: 0.58, phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
      { start: 0.58, end: 0.75, phase: "Secondary T-wave changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleLbbb(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, lbbbMorphQrs(tt, 0.34, 0.95));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.68, 0.055, 0.35), {
      I: -0.7,
      II: -0.4,
      III: 0.2,
      aVR: 0.55,
      aVL: -0.65,
      aVF: -0.15,
      V1: 0.75,
      V2: 0.65,
      V3: 0.25,
      V4: -0.35,
      V5: -0.7,
      V6: -0.8,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.38, phase: "Right bundle first · RV (LBB blocked)", active: ["rbb", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: 0.38, end: 0.54, phase: "Transseptal → distal left / LV", active: ["lbb", "lbba", "lbbp", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.54, end: 0.6, phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
      { start: 0.6, end: 0.8, phase: "Discordant T waves", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** Classic LAFB: left axis (~−45°), qR I/aVL, rS inferior — QRS usually not very wide */
function sampleLafb(t: number): WaveSample {
  const tt = clamp01(t);
  const axis = projectCardiacVector(1, vectorFromAxis(-45, 0.35));
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, 0.3, 0.012, -0.12) + gauss(tt, 0.325, 0.02, 0.85) + gauss(tt, 0.355, 0.018, -0.2),
      axis,
    ),
  );
  leads = addLeads(leads, tWaveLeads(tt, 0.58, 0.28, 0.045));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.36, phase: "RBB + LPF (LAF blocked)", active: ["rbb", "lbb", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.36, end: 0.46, phase: "Late anterior LV via myocardium", active: ["lbba", "myocardiumV"], mark: "QRS" },
      { start: 0.46, end: 0.54, phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: 0.54, end: 0.72, phase: "T wave", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** Classic LPFB: right axis (~+120°), rS I/aVL, qR inferior */
function sampleLpfb(t: number): WaveSample {
  const tt = clamp01(t);
  const axis = projectCardiacVector(1, vectorFromAxis(120, 0.35));
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, 0.3, 0.012, -0.1) + gauss(tt, 0.325, 0.02, 0.85) + gauss(tt, 0.355, 0.018, -0.18),
      axis,
    ),
  );
  leads = addLeads(leads, tWaveLeads(tt, 0.58, 0.28, 0.045));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.36, phase: "RBB + LAF (LPF blocked)", active: ["rbb", "lbb", "lbba", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.36, end: 0.46, phase: "Late posterior LV via myocardium", active: ["lbbp", "myocardiumV"], mark: "QRS" },
      { start: 0.46, end: 0.54, phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: 0.54, end: 0.72, phase: "T wave", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** RBBB + left axis (LAFB) */
function sampleRbbbLafb(t: number): WaveSample {
  const tt = clamp01(t);
  const early: Partial<Record<LeadId, number>> = {
    I: 0.7,
    II: -0.45,
    III: -0.75,
    aVR: -0.2,
    aVL: 0.9,
    aVF: -0.6,
    V1: -0.3,
    V2: -0.2,
    V3: 0.2,
    V4: 0.55,
    V5: 0.65,
    V6: 0.55,
  };
  const lateR: Partial<Record<LeadId, number>> = {
    I: -0.4,
    II: -0.2,
    III: 0.1,
    aVR: 0.3,
    aVL: -0.35,
    aVF: -0.05,
    V1: 1.1,
    V2: 0.9,
    V3: 0.3,
    V4: -0.1,
    V5: -0.4,
    V6: -0.5,
  };
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.3, 0.018, -0.1) + gauss(tt, 0.325, 0.022, 0.7), early));
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.38, 0.028, -0.12) + gauss(tt, 0.42, 0.03, 0.55), lateR));
  leads = addLeads(leads, tWaveLeads(tt, 0.64, 0.22, 0.05, { V1: -0.5, I: 0.35, aVL: 0.4, II: -0.2 }));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.38, phase: "LPF only (RBB + LAF blocked)", active: ["lbb", "lbbp", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.38, end: 0.54, phase: "Delayed RBB + anterior LV", active: ["rbb", "lbba", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: 0.54, end: 0.75, phase: "Secondary T changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** RBBB + right axis (LPFB) */
function sampleRbbbLpfb(t: number): WaveSample {
  const tt = clamp01(t);
  const early: Partial<Record<LeadId, number>> = {
    I: -0.45,
    II: 0.75,
    III: 0.9,
    aVR: -0.2,
    aVL: -0.65,
    aVF: 0.85,
    V1: -0.3,
    V2: -0.15,
    V3: 0.25,
    V4: 0.6,
    V5: 0.55,
    V6: 0.35,
  };
  const lateR: Partial<Record<LeadId, number>> = {
    I: -0.35,
    II: -0.15,
    III: 0.15,
    aVR: 0.3,
    aVL: -0.3,
    aVF: 0.05,
    V1: 1.1,
    V2: 0.9,
    V3: 0.3,
    V4: -0.1,
    V5: -0.35,
    V6: -0.45,
  };
  let leads = pWaveLeads(tt, 0.1);
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.3, 0.018, -0.1) + gauss(tt, 0.325, 0.022, 0.7), early));
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.38, 0.028, -0.12) + gauss(tt, 0.42, 0.03, 0.55), lateR));
  leads = addLeads(leads, tWaveLeads(tt, 0.64, 0.22, 0.05, { V1: -0.5, III: 0.35, aVF: 0.3, I: -0.2 }));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.38, phase: "LAF only (RBB + LPF blocked)", active: ["lbb", "lbba", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.38, end: 0.54, phase: "Delayed RBB + posterior LV", active: ["rbb", "lbbp", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: 0.54, end: 0.75, phase: "Secondary T changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

/** Ectopic atrial P′ — often inverted inferior / different from sinus */
const PAC_P_VEC = projectCardiacVector(1, { x: 0.25, y: -0.75, z: 0.15 });

function addNarrowBeat(
  leads: Record<LeadId, number>,
  tt: number,
  cycle: number,
  pSec: number,
  opts?: { pac?: boolean; amp?: number },
): Record<LeadId, number> {
  const abs = (sec: number) => sec / cycle;
  const qSec = pSec + 0.16;
  const tSec = pSec + 0.44;
  const amp = opts?.amp ?? 1;
  let out = leads;
  if (opts?.pac) {
    out = addLeads(out, scaleLeads(gauss(tt, abs(pSec), abs(0.022), 0.16), PAC_P_VEC));
  } else {
    out = addLeads(out, pWaveLeads(tt, abs(pSec), 0.17, abs(0.025)));
  }
  out = addLeads(out, qrsLeads(tt, abs(qSec), abs(0.027), amp, -0.05, -0.16));
  out = addLeads(out, tWaveLeads(tt, abs(tSec), 0.28, abs(0.05)));
  return out;
}

function addPvcBeat(leads: Record<LeadId, number>, tt: number, cycle: number, qSec: number): Record<LeadId, number> {
  const abs = (sec: number) => sec / cycle;
  let out = addLeads(leads, wideQrsLeads(tt, abs(qSec), 1.15, cycle));
  out = addLeads(out, scaleLeads(gauss(tt, abs(qSec + 0.24), abs(0.055), -0.38), VT_DISCORDANT_T));
  return out;
}

function samplePac(t: number): WaveSample {
  const tt = clamp01(t);
  /** Multi-beat strip: sinus beats + PACs only (no PVCs), every QRS has a T. */
  const CYCLE = 7.0;
  const abs = (sec: number) => sec / CYCLE;

  // Slightly irregular sinus PP and two PACs at different couplings
  // Times are absolute seconds within the pattern window.
  const beats: { kind: "sinus" | "pac"; p: number }[] = [
    { kind: "sinus", p: 0.14 },
    { kind: "sinus", p: 0.98 }, // RR ~0.84
    { kind: "pac", p: 1.52 }, // early after prior QRS (~0.54s coupling)
    { kind: "sinus", p: 2.42 }, // incomplete pause / SA reset from PAC
    { kind: "sinus", p: 3.30 }, // RR ~0.88
    { kind: "pac", p: 3.78 }, // different coupling (~0.48s)
    { kind: "sinus", p: 4.70 },
    { kind: "sinus", p: 5.58 },
  ];

  let leads = emptyLeads();
  for (const b of beats) {
    leads = addNarrowBeat(leads, tt, CYCLE, b.p, { pac: b.kind === "pac" });
  }

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Diastole", active: [], mark: "TP" };
  for (const b of beats) {
    const p = abs(b.p);
    const q = abs(b.p + 0.16);
    const tw = abs(b.p + 0.44);
    if (tt >= p - abs(0.02) && tt < q - abs(0.02)) {
      meta =
        b.kind === "pac"
          ? { phase: "PAC · ectopic P′", active: ["internodal", "myocardiumA"], mark: "P" }
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
  return pack(leads, meta);
}

function samplePvc(t: number): WaveSample {
  const tt = clamp01(t);
  /** Multi-beat strip: sinus beats + PVCs only (no PACs), every QRS has a T. */
  const CYCLE = 7.0;
  const abs = (sec: number) => sec / CYCLE;
  const RR = 0.86;

  // Sinus anchors and PVCs at slightly different couplings; compensatory pause after each PVC
  type Beat =
    | { kind: "sinus"; p: number }
    | { kind: "pvc"; q: number; afterSinusQ: number };
  const beats: Beat[] = [];
  // Sinus 1
  beats.push({ kind: "sinus", p: 0.14 });
  // Sinus 2
  beats.push({ kind: "sinus", p: 1.0 });
  const q2 = 1.16;
  // PVC A — coupling ~0.56 s
  beats.push({ kind: "pvc", q: q2 + 0.56, afterSinusQ: q2 });
  // Next sinus after full compensatory (from q2)
  const pAfterA = q2 + 2 * RR - 0.16;
  beats.push({ kind: "sinus", p: pAfterA });
  const q3 = pAfterA + 0.16;
  // Sinus 4 (slight RR jitter)
  beats.push({ kind: "sinus", p: q3 + 0.9 - 0.16 });
  const q4 = q3 + 0.9;
  // PVC B — different coupling ~0.48 s
  beats.push({ kind: "pvc", q: q4 + 0.48, afterSinusQ: q4 });
  const pAfterB = q4 + 2 * RR - 0.16;
  if (pAfterB + 0.5 < CYCLE - 0.05) {
    beats.push({ kind: "sinus", p: pAfterB });
  }

  let leads = emptyLeads();
  for (const b of beats) {
    if (b.kind === "sinus") leads = addNarrowBeat(leads, tt, CYCLE, b.p);
    else leads = addPvcBeat(leads, tt, CYCLE, b.q);
  }

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Diastole", active: [], mark: "TP" };
  for (const b of beats) {
    if (b.kind === "sinus") {
      const p = abs(b.p);
      const q = abs(b.p + 0.16);
      const tw = abs(b.p + 0.44);
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
    } else {
      const q = abs(b.q);
      const tw = abs(b.q + 0.24);
      if (tt >= q - abs(0.04) && tt < q + abs(0.16)) {
        meta = { phase: "PVC · wide QRS · no preceding P", active: ["myocardiumV", "purkinjeL"], mark: "QRS" };
      } else if (tt >= tw - abs(0.06) && tt < tw + abs(0.1)) {
        meta = { phase: "Discordant T after PVC", active: ["myocardiumV"], mark: "T" };
      } else if (tt > tw + abs(0.1) && tt < abs(b.afterSinusQ + 2 * RR - 0.2)) {
        meta = { phase: "Full compensatory pause", active: [], mark: "TP" };
      }
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

  // Long-QT sinus → R-on-T → TdP (~220/min) on absolute paper time
  leads = addLeads(leads, pWaveLeads(tt, nrm(0.12, CYCLE), 0.14, 0.025 * s));
  leads = addLeads(leads, qrsLeads(tt, nrm(0.28, CYCLE), 0.028 * s, 0.75, -0.05, -0.14));
  leads = addLeads(leads, tWaveLeads(tt, nrm(0.55, CYCLE), 0.4, 0.08 * s));
  leads = addLeads(leads, scaleLeads(gauss(tt, nrm(0.85, CYCLE), 0.06 * s, 0.16), NSR_T));

  const pvcMu = nrm(1.15, CYCLE);
  const vtS = 0.4 / CYCLE;
  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, pvcMu - 0.04 * vtS, 0.03 * vtS, -0.15) +
        gauss(tt, pvcMu, 0.055 * vtS, 0.75) +
        gauss(tt, pvcMu + 0.06 * vtS, 0.04 * vtS, -0.35) +
        gauss(tt, pvcMu + 0.1 * vtS, 0.03 * vtS, 0.25),
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

  // TdP run: R–R ~270 ms ≈ 220/min
  const nBeats = 12;
  const t0 = 1.35;
  const beatRrSec = 0.27;

  for (let i = 0; i < nBeats; i++) {
    const mu = nrm(t0 + i * beatRrSec, CYCLE);
    if (mu > 0.98) break;
    const twist = Math.sin((i / 5.5) * Math.PI);
    const pol = twist >= 0 ? 1 : -1;
    const envelope = 0.45 + 0.6 * Math.abs(Math.sin((i / (nBeats - 1)) * Math.PI * 1.6));
    const amp = envelope * (0.85 + 0.2 * Math.abs(twist));
    const bw = beatRrSec / CYCLE;

    const shape =
      gauss(tt, mu - 0.12 * bw, 0.08 * bw, -0.2 * pol * amp) +
      gauss(tt, mu, 0.16 * bw, pol * amp) +
      gauss(tt, mu + 0.18 * bw, 0.14 * bw, -0.5 * pol * amp) +
      gauss(tt, mu + 0.32 * bw, 0.12 * bw, 0.25 * pol * amp);

    const axis = twist;
    const w: Partial<Record<LeadId, number>> = {
      I: 0.5 + 0.4 * axis,
      II: 1.1,
      III: 0.8 - 0.2 * axis,
      aVR: -0.55,
      aVL: 0.2 + 0.35 * axis,
      aVF: 1.0,
      V1: -0.5 * axis,
      V2: -0.3 * axis,
      V3: 0.2 * Math.abs(axis),
      V4: 0.5 + 0.2 * axis,
      V5: 0.75,
      V6: 0.8,
    };
    leads = addLeads(leads, scaleLeads(shape, w));
  }

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Torsades de pointes",
    active: ["myocardiumV"],
    mark: "QRS",
  };
  if (tt < nrm(0.2, CYCLE)) meta = { phase: "Sinus P (long-QT context)", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  else if (tt < nrm(0.4, CYCLE)) meta = { phase: "Sinus QRS", active: ["his", "rbb", "lbb", "myocardiumV"], mark: "QRS" };
  else if (tt < nrm(1.1, CYCLE)) meta = { phase: "Prolonged QT / U wave", active: ["myocardiumV"], mark: "T" };
  else if (tt < nrm(1.3, CYCLE)) meta = { phase: "R-on-T PVC · initiates TdP", active: ["myocardiumV", "purkinjeL"], mark: "QRS" };
  else meta = { phase: "Twisting polymorphic VT (TdP)", active: ["myocardiumV", "purkinjeL", "purkinjeR"], mark: "QRS" };

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

function sampleAvnrt(t: number): WaveSample {
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
      { start: 0.0, end: 0.12, phase: "AVNRT · slow pathway anterograde", active: ["avnrtSlow", "av"], mark: "PR" },
      { start: 0.12, end: 0.28, phase: "His–Purkinje · narrow QRS", active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.28, end: 0.45, phase: "Retrograde P on early T (P-on-T)", active: ["avnrtFast", "av", "internodal", "myocardiumA", "myocardiumV"], mark: "T" },
      { start: 0.45, end: 0.85, phase: "T wave · next cycle imminent", active: ["myocardiumV"], mark: "T" },
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

function sampleWpw(t: number): WaveSample {
  const tt = clamp01(t);
  const deltaW: Partial<Record<LeadId, number>> = {
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
  };
  const wideW: Partial<Record<LeadId, number>> = {
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
  };

  let leads = pWaveLeads(tt, 0.1, 0.15);
  const delta =
    gauss(tt, 0.18, 0.028, 0.22) +
    gauss(tt, 0.22, 0.032, 0.45) +
    gauss(tt, 0.27, 0.03, 0.35);
  leads = addLeads(leads, scaleLeads(delta, deltaW));
  const qrsBody =
    gauss(tt, 0.3, 0.028, 0.85) +
    gauss(tt, 0.34, 0.03, -0.15) +
    gauss(tt, 0.38, 0.025, -0.08);
  leads = addLeads(leads, scaleLeads(qrsBody, wideW));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.55, 0.06, 0.28), {
      I: -0.55,
      II: -0.4,
      III: -0.15,
      aVR: 0.4,
      aVL: -0.45,
      aVF: -0.3,
      V1: -0.5,
      V2: -0.55,
      V3: -0.4,
      V4: -0.35,
      V5: -0.4,
      V6: -0.4,
    }),
  );

  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.15, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.15, end: 0.24, phase: "Accessory pathway · delta wave (short PR)", active: ["accessory", "myocardiumV"], mark: "PR" },
      { start: 0.24, end: 0.4, phase: "Fusion QRS (AV + Kent)", active: ["av", "his", "rbb", "lbb", "accessory", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: 0.48, phase: "ST segment", active: ["myocardiumV"], mark: "ST" },
      { start: 0.48, end: 0.7, phase: "Secondary T-wave changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleStemi(t: number): WaveSample {
  const tt = clamp01(t);
  const qrsMu = 0.32;
  const tMu = 0.62;

  let leads = pWaveLeads(tt, 0.1);
  const qAnt = gauss(tt, qrsMu - 0.03, 0.018, -0.45);
  leads = addLeads(
    leads,
    scaleLeads(
      qAnt,
      {
        I: 0.05,
        II: 0.02,
        III: 0,
        aVR: 0,
        aVL: 0.08,
        aVF: 0,
        V1: 1.0,
        V2: 1.0,
        V3: 0.85,
        V4: 0.35,
        V5: 0.05,
        V6: 0,
      },
      { precordial: "local" },
    ),
  );
  leads = addLeads(leads, qrsLeads(tt, qrsMu, 0.028, 0.95, -0.05, -0.18));

  let st = 0;
  if (tt > qrsMu + 0.03 && tt < 0.78) {
    const u = (tt - (qrsMu + 0.03)) / (0.78 - (qrsMu + 0.03));
    st = u < 0.25 ? 0.55 * Math.sin((u / 0.25) * Math.PI * 0.5) : 0.55 + 0.12 * Math.sin((u - 0.25) * Math.PI);
  }
  leads = addLeads(
    leads,
    scaleLeads(
      st,
      {
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
      { precordial: "local" },
    ),
  );

  leads = addLeads(
    leads,
    scaleLeads(
      gauss(tt, tMu, 0.07, 0.55),
      {
        I: 0.25,
        II: -0.1,
        III: -0.15,
        aVR: 0.05,
        aVL: 0.3,
        aVF: -0.12,
        V1: 0.7,
        V2: 1.0,
        V3: 1.05,
        V4: 0.9,
        V5: 0.35,
        V6: 0.15,
      },
      { precordial: "local" },
    ),
  );

  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.16, phase: "SA · atria", active: ["sa", "internodal", "myocardiumA"], mark: "P" },
      { start: 0.16, end: 0.28, phase: "AV · His", active: ["av", "his"], mark: "PR" },
      { start: 0.28, end: 0.4, phase: "QRS · anterior Q waves", active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.4, end: 0.55, phase: "Injury current · ST elevation V1–V4", active: ["myocardiumV"], mark: "ST" },
      { start: 0.55, end: 0.78, phase: "Hyperacute T · ongoing injury", active: ["myocardiumV"], mark: "T" },
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
  let leads = paceSpike(tt, spikeT, 0.6);
  leads = addLeads(leads, pacedQrsLeads(tt, qrsMu, 1.0));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.64, 0.055, 0.32), {
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
      { start: 0.24, end: 0.5, phase: "Captured wide QRS (LBBB-like)", active: ["purkinjeR", "purkinjeL", "rbb", "myocardiumV"], mark: "QRS" },
      { start: 0.5, end: 0.58, phase: "ST", active: ["myocardiumV"], mark: "ST" },
      { start: 0.58, end: 0.8, phase: "Discordant T", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedDual(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = paceSpike(tt, 0.08, 0.45);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.16));
  leads = addLeads(leads, paceSpike(tt, 0.28, 0.55));
  leads = addLeads(leads, pacedQrsLeads(tt, 0.36, 0.95));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.68, 0.05, 0.3), {
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
      { start: 0.11, end: 0.2, phase: "Captured P", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.2, end: 0.28, phase: "AV delay (paced)", active: ["av"], mark: "PR" },
      { start: 0.28, end: 0.32, phase: "Ventricular pacing spike · RV apical", active: [], mark: "QRS" },
      { start: 0.32, end: 0.52, phase: "Captured wide QRS", active: ["purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" },
      { start: 0.52, end: 0.8, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedLbap(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = paceSpike(tt, 0.08, 0.4);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.16));
  leads = addLeads(leads, paceSpike(tt, 0.26, 0.5));
  // Narrower than RV apical — conduction-system capture after spike
  leads = addLeads(leads, qrsLeads(tt, 0.34, 0.026, 1.05));
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.36, 0.02, 0.15), { V1: -0.2, I: 0.15, V6: 0.2 }));
  leads = addLeads(leads, tWaveLeads(tt, 0.6, 0.26, 0.045));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.05, end: 0.11, phase: "Atrial pacing spike · RA", active: ["sa", "myocardiumA"], mark: "P" },
      { start: 0.11, end: 0.2, phase: "Captured P", active: ["internodal", "myocardiumA"], mark: "P" },
      { start: 0.2, end: 0.26, phase: "AV delay", active: ["av"], mark: "PR" },
      { start: 0.26, end: 0.3, phase: "LBAP spike · left bundle area", active: [], mark: "QRS" },
      { start: 0.3, end: 0.48, phase: "Physiologic / narrow QRS", active: ["lbb", "lbba", "lbbp", "rbb", "purkinjeL", "purkinjeR", "myocardiumV"], mark: "QRS" },
      { start: 0.48, end: 0.75, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function samplePacedBiv(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = paceSpike(tt, 0.08, 0.4);
  leads = addLeads(leads, pWaveLeads(tt, 0.12, 0.15));
  leads = addLeads(leads, paceSpike(tt, 0.27, 0.55));
  // Fusion QRS — after BiV spike
  leads = addLeads(leads, pacedQrsLeads(tt, 0.34, 0.7));
  leads = addLeads(leads, qrsLeads(tt, 0.36, 0.022, 0.45));
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.66, 0.05, 0.22), {
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
      { start: 0.31, end: 0.5, phase: "Fusion QRS · CRT capture", active: ["purkinjeR", "purkinjeL", "rbb", "lbb", "myocardiumV"], mark: "QRS" },
      { start: 0.5, end: 0.8, phase: "Repolarization", active: ["myocardiumV"], mark: "T" },
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
  avnrt: sampleAvnrt,
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
  wpw: sampleWpw,
  stemiAnt: sampleStemi,
  pacedAtrial: samplePacedAtrial,
  pacedVentricular: samplePacedVentricular,
  pacedDual: samplePacedDual,
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
  if (from === "avnrt" || from === "sinusTachy") return 6.4;
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
    case "avnrt":
      return "AVNRT";
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
