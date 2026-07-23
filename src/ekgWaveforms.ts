import type { FindingId, SegmentId } from "./findings";

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

function scaleLeads(base: number, weights: Partial<Record<LeadId, number>>): Record<LeadId, number> {
  const out = emptyLeads();
  for (const lead of LEADS) {
    out[lead] = base * (weights[lead] ?? 0);
  }
  return out;
}

function addLeads(a: Record<LeadId, number>, b: Record<LeadId, number>): Record<LeadId, number> {
  const out = emptyLeads();
  for (const lead of LEADS) out[lead] = a[lead] + b[lead];
  return out;
}

/** Normal QRS axis ~ +60° — tall II/aVF, modest I, progressive precordials */
const NSR_P: Partial<Record<LeadId, number>> = {
  I: 0.55,
  II: 1.0,
  III: 0.55,
  aVR: -0.7,
  aVL: 0.15,
  aVF: 0.85,
  V1: -0.25,
  V2: -0.1,
  V3: 0.25,
  V4: 0.55,
  V5: 0.7,
  V6: 0.75,
};

const NSR_QRS: Partial<Record<LeadId, number>> = {
  I: 0.75,
  II: 1.05,
  III: 0.45,
  aVR: -0.85,
  aVL: 0.35,
  aVF: 0.8,
  V1: -0.55,
  V2: -0.35,
  V3: 0.35,
  V4: 1.05,
  V5: 1.15,
  V6: 1.0,
};

const NSR_T: Partial<Record<LeadId, number>> = {
  I: 0.7,
  II: 1.0,
  III: 0.4,
  aVR: -0.75,
  aVL: 0.3,
  aVF: 0.75,
  V1: -0.15,
  V2: 0.25,
  V3: 0.55,
  V4: 0.85,
  V5: 0.9,
  V6: 0.8,
};

function pWaveLeads(t: number, mu = 0.1, amp = 0.18): Record<LeadId, number> {
  return scaleLeads(gauss(t, mu, 0.025, amp), NSR_P);
}

function qrsLeads(
  t: number,
  mu = 0.32,
  width = 0.028,
  amp = 1.0,
  q = -0.08,
  s = -0.22,
  weights: Partial<Record<LeadId, number>> = NSR_QRS,
): Record<LeadId, number> {
  const shape =
    gauss(t, mu - width * 0.55, width * 0.35, q) +
    gauss(t, mu, width * 0.42, amp) +
    gauss(t, mu + width * 0.7, width * 0.4, s);
  return scaleLeads(shape, weights);
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

function wideQrsLeads(t: number, mu = 0.32, amp = 0.95): Record<LeadId, number> {
  const shape =
    gauss(t, mu - 0.04, 0.03, -0.15) +
    gauss(t, mu, 0.055, amp) +
    gauss(t, mu + 0.06, 0.04, -0.35) +
    gauss(t, mu + 0.1, 0.03, 0.25);
  // Discordant / extreme axis-ish for VT/PVC
  const w: Partial<Record<LeadId, number>> = {
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
  return scaleLeads(shape, w);
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
  const w: Partial<Record<LeadId, number>> = {
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
  };
  return scaleLeads(shape, w);
}

function lbbbMorphQrs(t: number, mu: number, amp = 1.0): Record<LeadId, number> {
  const shape =
    gauss(t, mu - 0.015, 0.02, -0.05) +
    gauss(t, mu + 0.02, 0.048, amp * 0.7) +
    gauss(t, mu + 0.07, 0.045, amp) +
    gauss(t, mu + 0.12, 0.03, -0.2);
  const w: Partial<Record<LeadId, number>> = {
    I: 0.95,
    II: 0.55,
    III: -0.3,
    aVR: -0.7,
    aVL: 0.85,
    aVF: 0.1,
    V1: -1.1,
    V2: -1.0,
    V3: -0.3,
    V4: 0.4,
    V5: 0.95,
    V6: 1.05,
  };
  return scaleLeads(shape, w);
}

function rbbbMorphQrs(t: number, mu: number, amp = 1.0): Record<LeadId, number> {
  const shape =
    gauss(t, mu - 0.02, 0.02, -0.12) +
    gauss(t, mu + 0.01, 0.03, amp * 0.55) +
    gauss(t, mu + 0.06, 0.035, amp) +
    gauss(t, mu + 0.11, 0.03, -0.25);
  const w: Partial<Record<LeadId, number>> = {
    I: -0.35,
    II: -0.55,
    III: -0.45,
    aVR: 0.55,
    aVL: -0.15,
    aVF: -0.5,
    V1: 1.15,
    V2: 1.0,
    V3: 0.35,
    V4: -0.45,
    V5: -0.75,
    V6: -0.85,
  };
  return scaleLeads(shape, w);
}

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

  // Coarse/fine f waves — chaotic, no discrete P; most obvious in V1
  const fibW: Partial<Record<LeadId, number>> = {
    I: 0.25,
    II: 0.45,
    III: 0.4,
    aVR: -0.3,
    aVL: 0.1,
    aVF: 0.4,
    V1: 1.0,
    V2: 0.55,
    V3: 0.25,
    V4: 0.15,
    V5: 0.12,
    V6: 0.1,
  };
  for (let i = 0; i < 11; i++) {
    const freq = 18 + i * 3.7;
    const phase = i * 1.9;
    const amp = 0.035 + 0.012 * (i % 4);
    const fib = Math.sin((tt * freq + phase) * Math.PI * 2) * amp;
    const fib2 = Math.sin((tt * (freq * 1.37) + phase * 0.7) * Math.PI * 2) * amp * 0.55;
    leads = addLeads(leads, scaleLeads(fib + fib2, fibW));
  }

  // Irregularly irregular narrow QRS (uneven RR)
  const beats = [0.06, 0.27, 0.41, 0.68, 0.91];
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Fibrillatory atria · SA quiescent · no P waves",
    active: ["myocardiumA", "internodal"],
    mark: "TP",
  };

  for (const b of beats) {
    const inQrs = tt >= b - 0.02 && tt < b + 0.1;
    const inT = tt >= b + 0.1 && tt < b + 0.18;
    if (inQrs || inT) {
      leads = addLeads(leads, qrsLeads(tt, b, 0.024, 1.0, -0.06, -0.18));
      leads = addLeads(leads, tWaveLeads(tt, b + 0.12, 0.24, 0.038));
    }
    if (inQrs) {
      meta = {
        phase: "Irregular QRS · no preceding P · SA still silent",
        // No "sa" — ventricles conduct without sinus origin
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
   * Typical CTI flutter teaching morphologies (not mere polarity flips):
   * CCW: continuous inferior NEGATIVE sawtooth (no isoelectric baseline);
   *      V1 often shows discrete POSITIVE F waves.
   * CW:  inferior POSITIVE rounded/notched F waves (broader, less “picket-fence”);
   *      V1 often broad NEGATIVE or biphasic F waves.
   */
  const period = 0.2;
  const f0 = 0.04;
  const phase = ((tt - f0) % period + period) % period;
  const u = phase / period; // 0→1 within current F wave
  const fIndex = Math.min(4, Math.max(0, Math.floor((tt - f0 + 1e-6) / period)));

  if (dir === "ccw") {
    // Inferior: sharp upstroke from trough, then slow descent → classic sawtooth
    const inf =
      u < 0.18 ? -0.42 + (u / 0.18) * 0.62 : 0.2 - ((u - 0.18) / 0.82) * 0.62;
    leads = addLeads(
      leads,
      scaleLeads(inf, {
        I: 0.15,
        II: 1.15,
        III: 1.05,
        aVR: 0.45,
        aVL: -0.55,
        aVF: 1.15,
        V1: 0.05,
        V2: 0.04,
        V3: 0.03,
        V4: 0.03,
        V5: 0.04,
        V6: 0.05,
      }),
    );
    // V1: discrete upright F peaks (one per period)
    const mu = f0 + fIndex * period;
    const v1 = gauss(tt, mu + 0.045, 0.016, 0.3) + gauss(tt, mu + 0.095, 0.014, -0.07);
    leads = addLeads(
      leads,
      scaleLeads(v1, {
        I: 0.02,
        II: 0.03,
        III: 0.03,
        aVR: -0.08,
        aVL: 0.02,
        aVF: 0.03,
        V1: 1.0,
        V2: 0.55,
        V3: 0.18,
        V4: 0.04,
        V5: 0.02,
        V6: 0.02,
      }),
    );
  } else {
    // CW inferior: broad positive dome + shallow trough (≠ inverted CCW)
    const inf =
      u < 0.45
        ? 0.4 * Math.sin((u / 0.45) * Math.PI)
        : -0.14 * Math.sin(((u - 0.45) / 0.55) * Math.PI);
    leads = addLeads(
      leads,
      scaleLeads(inf, {
        I: -0.28,
        II: 1.05,
        III: 0.95,
        aVR: -0.4,
        aVL: 0.4,
        aVF: 1.05,
        V1: 0.04,
        V2: 0.03,
        V3: 0.03,
        V4: 0.03,
        V5: 0.04,
        V6: 0.05,
      }),
    );
    // V1: broad negative F waves
    const mu = f0 + fIndex * period;
    const v1 = gauss(tt, mu + 0.055, 0.03, -0.34) + gauss(tt, mu + 0.13, 0.02, 0.09);
    leads = addLeads(
      leads,
      scaleLeads(v1, {
        I: 0.02,
        II: 0.02,
        III: 0.02,
        aVR: 0.06,
        aVL: -0.02,
        aVF: 0.02,
        V1: 1.0,
        V2: 0.6,
        V3: 0.2,
        V4: 0.05,
        V5: 0.02,
        V6: 0.02,
      }),
    );
  }

  const qrsTimes = [0.18, 0.58];
  const limbs = ["CTI", "septal ascending", "RA roof", "crista descending"] as const;
  const lap = period;
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: dir === "ccw" ? "Flutter circuit · CCW" : "Flutter circuit · CW",
    active: ["flutter", "myocardiumA"],
    mark: "P",
  };

  for (let lapI = 0; lapI < 5; lapI++) {
    const base = f0 + lapI * lap;
    if (tt >= base && tt < base + lap) {
      const frac = (tt - base) / lap;
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
    const inQrs = tt >= b - 0.02 && tt < b + 0.11;
    const inSt = tt >= b + 0.11 && tt < b + 0.16;
    const inT = tt >= b + 0.16 && tt < b + 0.24;
    if (inQrs || inSt || inT) {
      leads = addLeads(leads, qrsLeads(tt, b, 0.024, 1.0, -0.05, -0.16));
      leads = addLeads(leads, tWaveLeads(tt, b + 0.15, 0.04, 0.022));
    }
    // QRS/ST/T meta must win over continuous F-wave "P" so the model stays in sync
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
  // Classic 4:3 Wenckebach: progressive PR → drop
  const events: { p: number; qrs: number | null }[] = [
    { p: 0.05, qrs: 0.18 },
    { p: 0.28, qrs: 0.48 },
    { p: 0.52, qrs: 0.78 },
    { p: 0.78, qrs: null },
  ];
  let leads = emptyLeads();
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Wenckebach sequence",
    active: [],
    mark: "TP",
  };
  for (const e of events) {
    leads = addLeads(leads, pWaveLeads(tt, e.p));
    if (Math.abs(tt - e.p) < 0.04) {
      meta = { phase: "Atrial depolarization", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    }
    if (e.qrs != null) {
      leads = addLeads(leads, addLeads(qrsLeads(tt, e.qrs), tWaveLeads(tt, e.qrs + 0.16, 0.22, 0.035)));
      if (tt >= e.qrs - 0.02 && tt < e.qrs + 0.11) {
        const pr = e.qrs - e.p;
        meta = {
          phase: pr < 0.18 ? "Conducted (shorter PR)" : pr < 0.24 ? "Conducted (longer PR)" : "Conducted (longest PR)",
          active: ["av", "his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
          mark: "QRS",
        };
      } else if (tt >= e.qrs + 0.11 && tt < e.qrs + 0.22) {
        meta = { phase: "T wave", active: ["myocardiumV"], mark: "T" };
      } else if (tt > e.p && tt < e.qrs) {
        meta = { phase: "Lengthening AV delay", active: ["av"], mark: "PR" };
      }
    } else if (tt > e.p && tt < e.p + 0.18) {
      meta = { phase: "Blocked P · no ventricular activation", active: ["av"], mark: "PR" };
    }
  }
  return pack(leads, meta);
}

function sampleAv2ii(t: number): WaveSample {
  const tt = clamp01(t);
  // Constant PR ~180 ms when conducted; sudden drop (infra-His)
  const events: { p: number; qrs: number | null }[] = [
    { p: 0.08, qrs: 0.26 },
    { p: 0.4, qrs: null },
    { p: 0.68, qrs: 0.86 },
  ];
  let leads = emptyLeads();
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Mobitz II",
    active: [],
    mark: "TP",
  };
  for (const e of events) {
    leads = addLeads(leads, pWaveLeads(tt, e.p));
    if (Math.abs(tt - e.p) < 0.04) {
      meta = { phase: "P wave", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    }
    if (e.qrs != null) {
      leads = addLeads(leads, addLeads(qrsLeads(tt, e.qrs), tWaveLeads(tt, e.qrs + 0.2, 0.28, 0.04)));
      if (tt >= e.qrs - 0.02 && tt < e.qrs + 0.11) {
        meta = {
          phase: "Conducted · infra-His intact",
          active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
          mark: "QRS",
        };
      } else if (tt >= e.qrs + 0.11 && tt < e.qrs + 0.24) {
        meta = { phase: "T wave", active: ["myocardiumV"], mark: "T" };
      } else if (tt > e.p && tt < e.qrs) {
        meta = { phase: "PR interval (stable)", active: ["av"], mark: "PR" };
      }
    } else if (tt > e.p && tt < e.p + 0.16) {
      meta = { phase: "Sudden block in His–Purkinje", active: ["his"], mark: "PR" };
    }
  }
  return pack(leads, meta);
}

function sampleAv3Junctional(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  // Atrial ~100 · narrow junctional escape ~45
  const pTimes = [0.04, 0.28, 0.52, 0.76];
  for (const p of pTimes) leads = addLeads(leads, pWaveLeads(tt, p, 0.16));
  const escapes = [0.22, 0.72];
  for (const escape of escapes) {
    leads = addLeads(leads, addLeads(qrsLeads(tt, escape, 0.022, 0.95), tWaveLeads(tt, escape + 0.18, 0.28, 0.045)));
  }
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Complete block · junctional escape (supra-His)",
    active: [],
    mark: "TP",
  };
  if (pTimes.some((p) => Math.abs(tt - p) < 0.035)) {
    meta = { phase: "Atrial depolarization · blocked at AV node", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  }
  for (const escape of escapes) {
    if (tt >= escape - 0.02 && tt < escape + 0.1) {
      meta = {
        phase: "Junctional / His escape · narrow QRS",
        active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      };
    } else if (tt >= escape + 0.1 && tt < escape + 0.24) {
      meta = { phase: "Escape T · A–V dissociation", active: ["myocardiumV"], mark: "T" };
    }
  }
  return pack(leads, meta);
}

function sampleAv3(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  // Atrial rate ~100 · ventricular escape ~40 (2 escapes / cycle)
  const pTimes = [0.04, 0.28, 0.52, 0.76];
  for (const p of pTimes) leads = addLeads(leads, pWaveLeads(tt, p, 0.16));
  const escapes = [0.2, 0.7];
  for (const escape of escapes) {
    leads = addLeads(
      leads,
      addLeads(wideQrsLeads(tt, escape, 0.85), tWaveLeads(tt, escape + 0.2, -0.22, 0.05)),
    );
  }
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Complete block · ventricular escape (infra-His)",
    active: [],
    mark: "TP",
  };
  if (pTimes.some((p) => Math.abs(tt - p) < 0.035)) {
    meta = { phase: "Atrial depolarization · blocked below His", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  }
  for (const escape of escapes) {
    if (Math.abs(tt - escape) < 0.07) {
      meta = { phase: "Ventricular escape focus · wide QRS", active: ["purkinjeL", "purkinjeR", "myocardiumV"], mark: "QRS" };
    } else if (tt > escape + 0.07 && tt < escape + 0.22) {
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

/** Classic LAFB: left axis, qR I/aVL, rS inferior — QRS usually not very wide */
function sampleLafb(t: number): WaveSample {
  const tt = clamp01(t);
  const axis: Partial<Record<LeadId, number>> = {
    I: 0.75,
    II: -0.55,
    III: -0.85,
    aVR: -0.15,
    aVL: 0.95,
    aVF: -0.7,
    V1: -0.35,
    V2: -0.15,
    V3: 0.35,
    V4: 0.75,
    V5: 0.85,
    V6: 0.7,
  };
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

/** Classic LPFB: right axis, rS I/aVL, qR inferior */
function sampleLpfb(t: number): WaveSample {
  const tt = clamp01(t);
  const axis: Partial<Record<LeadId, number>> = {
    I: -0.55,
    II: 0.85,
    III: 0.95,
    aVR: -0.25,
    aVL: -0.7,
    aVF: 0.9,
    V1: -0.3,
    V2: -0.1,
    V3: 0.4,
    V4: 0.8,
    V5: 0.7,
    V6: 0.45,
  };
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

function samplePvc(t: number): WaveSample {
  const tt = clamp01(t);
  // Sinus → PVC → full compensatory pause → next sinus P
  let leads = addLeads(
    addLeads(pWaveLeads(tt, 0.08), qrsLeads(tt, 0.26)),
    tWaveLeads(tt, 0.48, 0.26, 0.04),
  );
  leads = addLeads(leads, addLeads(wideQrsLeads(tt, 0.58, 1.1), tWaveLeads(tt, 0.74, -0.35, 0.05)));
  // Next sinus arrives late (pause)
  leads = addLeads(leads, addLeads(pWaveLeads(tt, 0.9, 0.14), qrsLeads(tt, 0.98, 0.02, 0.35)));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Sinus beat", active: [], mark: "TP" };
  if (tt < 0.18) meta = { phase: "Sinus · SA activation", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  else if (tt < 0.26) meta = { phase: "PR", active: ["av"], mark: "PR" };
  else if (tt < 0.4) {
    meta = {
      phase: "Normal His–Purkinje",
      active: ["av", "his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
      mark: "QRS",
    };
  } else if (tt < 0.52) meta = { phase: "T wave", active: ["myocardiumV"], mark: "T" };
  else if (tt < 0.72) meta = { phase: "PVC · ectopic ventricular focus", active: ["myocardiumV", "purkinjeL"], mark: "QRS" };
  else if (tt < 0.88) meta = { phase: "Compensatory pause", active: [], mark: "TP" };
  else meta = { phase: "Next sinus P", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  return pack(leads, meta);
}

function sampleVt(t: number): WaveSample {
  const tt = clamp01(t);
  const leads = addLeads(wideQrsLeads(tt, 0.32, 1.05), tWaveLeads(tt, 0.7, -0.42, 0.048));
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.12, end: 0.55, phase: "Ventricular reentry · monomorphic", active: ["myocardiumV", "purkinjeL", "purkinjeR"], mark: "QRS" },
      { start: 0.55, end: 0.92, phase: "Wide-complex repolarization", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleVtMonoLbbb(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = lbbbMorphQrs(tt, 0.3, 1.05);
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.68, 0.05, 0.38), {
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
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.1, end: 0.55, phase: "Monomorphic VT · LBBB morphology", active: ["myocardiumV", "purkinjeR", "rbb"], mark: "QRS" },
      { start: 0.55, end: 0.9, phase: "Discordant T", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleVtMonoRbbb(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = rbbbMorphQrs(tt, 0.3, 1.05);
  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, 0.68, 0.05, 0.35), {
      I: 0.35,
      II: 0.45,
      III: 0.35,
      aVR: -0.4,
      aVL: 0.15,
      aVF: 0.4,
      V1: -0.7,
      V2: -0.55,
      V3: -0.15,
      V4: 0.35,
      V5: 0.55,
      V6: 0.6,
    }),
  );
  return pack(
    leads,
    phaseFor(tt, [
      { start: 0.1, end: 0.55, phase: "Monomorphic VT · RBBB morphology", active: ["myocardiumV", "purkinjeL", "lbb"], mark: "QRS" },
      { start: 0.55, end: 0.9, phase: "Secondary T changes", active: ["myocardiumV"], mark: "T" },
    ]),
  );
}

function sampleVtPoly(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  // Changing morphology beat-to-beat (not a smooth TdP twist)
  const beats: { mu: number; kind: "l" | "r" | "w" }[] = [
    { mu: 0.06, kind: "l" },
    { mu: 0.24, kind: "r" },
    { mu: 0.42, kind: "w" },
    { mu: 0.58, kind: "r" },
    { mu: 0.76, kind: "l" },
    { mu: 0.92, kind: "w" },
  ];
  for (const b of beats) {
    if (b.kind === "l") leads = addLeads(leads, lbbbMorphQrs(tt, b.mu, 0.95));
    else if (b.kind === "r") leads = addLeads(leads, rbbbMorphQrs(tt, b.mu, 0.95));
    else leads = addLeads(leads, wideQrsLeads(tt, b.mu, 1.0));
    leads = addLeads(leads, tWaveLeads(tt, b.mu + 0.1, -0.22, 0.028));
  }
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Polymorphic VT",
    active: ["myocardiumV"],
    mark: "QRS",
  };
  for (const b of beats) {
    if (Math.abs(tt - b.mu) < 0.07) {
      meta = {
        phase: "Beat-to-beat changing QRS morphology",
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

  // Classic teaching strip (~5s cycle): long-QT sinus → R-on-T → TdP at ~200/min
  leads = addLeads(leads, pWaveLeads(tt, 0.04, 0.14));
  leads = addLeads(leads, qrsLeads(tt, 0.12, 0.02, 0.75, -0.05, -0.14));
  // Markedly prolonged QT / broad T–U
  leads = addLeads(leads, tWaveLeads(tt, 0.22, 0.4, 0.055));
  leads = addLeads(leads, scaleLeads(gauss(tt, 0.28, 0.04, 0.16), NSR_T));

  // R-on-T initiating PVC
  leads = addLeads(leads, wideQrsLeads(tt, 0.3, 0.75));

  // TdP run: discrete wide QRS, polarity rotates ("twisting of the points"), spindle envelope
  // beatRr 0.054 of 5s ≈ 270 ms ≈ 220/min
  const nBeats = 12;
  const t0 = 0.34;
  const beatRr = 0.054;

  for (let i = 0; i < nBeats; i++) {
    const mu = t0 + i * beatRr;
    if (mu > 0.98) break;
    const twist = Math.sin((i / 5.5) * Math.PI);
    const pol = twist >= 0 ? 1 : -1;
    const envelope = 0.45 + 0.6 * Math.abs(Math.sin((i / (nBeats - 1)) * Math.PI * 1.6));
    const amp = envelope * (0.85 + 0.2 * Math.abs(twist));

    const shape =
      gauss(tt, mu - 0.01, 0.01, -0.2 * pol * amp) +
      gauss(tt, mu, 0.02, pol * amp) +
      gauss(tt, mu + 0.018, 0.016, -0.5 * pol * amp) +
      gauss(tt, mu + 0.034, 0.014, 0.25 * pol * amp);

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
  if (tt < 0.08) meta = { phase: "Sinus P (long-QT context)", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  else if (tt < 0.16) meta = { phase: "Sinus QRS", active: ["his", "rbb", "lbb", "myocardiumV"], mark: "QRS" };
  else if (tt < 0.3) meta = { phase: "Prolonged QT / U wave", active: ["myocardiumV"], mark: "T" };
  else if (tt < 0.34) meta = { phase: "R-on-T PVC · initiates TdP", active: ["myocardiumV", "purkinjeL"], mark: "QRS" };
  else meta = { phase: "Twisting polymorphic VT (TdP)", active: ["myocardiumV", "purkinjeL", "purkinjeR"], mark: "QRS" };

  return pack(leads, meta);
}

function sampleVf(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  // Fine + coarse VF: irregular undulations, no discrete QRS/T
  const fibW: Partial<Record<LeadId, number>> = {
    I: 0.65,
    II: 1.0,
    III: 0.8,
    aVR: 0.5,
    aVL: 0.45,
    aVF: 0.9,
    V1: 0.85,
    V2: 0.95,
    V3: 0.8,
    V4: 0.75,
    V5: 0.7,
    V6: 0.65,
  };
  for (let i = 0; i < 18; i++) {
    const freq = 16 + (i * 3.1) % 19;
    const amp = 0.045 + 0.04 * Math.abs(Math.sin(i * 2.3 + tt * 4));
    const v =
      Math.sin((tt * freq + i * 1.3) * Math.PI * 2) * amp +
      Math.sin((tt * (freq * 1.73) + i * 0.6) * Math.PI * 2) * amp * 0.7 +
      Math.sin((tt * (freq * 0.41) + i) * Math.PI * 2) * amp * 0.35;
    leads = addLeads(leads, scaleLeads(v, fibW));
  }
  return pack(leads, {
    phase: "Ventricular fibrillation · no organized QRS",
    active: ["myocardiumV"],
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
    scaleLeads(qAnt, {
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
    }),
  );
  leads = addLeads(leads, qrsLeads(tt, qrsMu, 0.028, 0.95, -0.05, -0.18));

  let st = 0;
  if (tt > qrsMu + 0.03 && tt < 0.78) {
    const u = (tt - (qrsMu + 0.03)) / (0.78 - (qrsMu + 0.03));
    st = u < 0.25 ? 0.55 * Math.sin((u / 0.25) * Math.PI * 0.5) : 0.55 + 0.12 * Math.sin((u - 0.25) * Math.PI);
  }
  leads = addLeads(
    leads,
    scaleLeads(st, {
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
    }),
  );

  leads = addLeads(
    leads,
    scaleLeads(gauss(tt, tMu, 0.07, 0.55), {
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
    }),
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
  // One successful V-paced beat, then missing spike/pause, then escape
  let leads = emptyLeads();
  leads = addLeads(leads, paceSpike(tt, 0.1, 0.55));
  leads = addLeads(leads, pacedQrsLeads(tt, 0.16, 0.9));
  leads = addLeads(leads, tWaveLeads(tt, 0.4, -0.25, 0.045));
  // Expected pace ~0.55 — absent — long pause
  leads = addLeads(leads, wideQrsLeads(tt, 0.82, 0.75));
  leads = addLeads(leads, tWaveLeads(tt, 0.95, -0.18, 0.04));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Output failure · no spike",
    active: [],
    mark: "TP",
  };
  if (tt < 0.14) meta = { phase: "Ventricular pacing spike", active: ["myocardiumV"], mark: "QRS" };
  else if (tt < 0.35) meta = { phase: "Captured paced QRS", active: ["purkinjeR", "myocardiumV"], mark: "QRS" };
  else if (tt < 0.55) meta = { phase: "Expected pace — no output", active: [], mark: "TP" };
  else if (tt < 0.78) meta = { phase: "Asystolic pause", active: [], mark: "TP" };
  else meta = { phase: "Escape beat", active: ["purkinjeL", "myocardiumV"], mark: "QRS" };
  return pack(leads, meta);
}

function sampleFailureToCapture(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  // Spikes without capture, then one that captures
  for (const s of [0.12, 0.38, 0.64]) {
    leads = addLeads(leads, paceSpike(tt, s, 0.6));
  }
  leads = addLeads(leads, pacedQrsLeads(tt, 0.7, 0.95));
  leads = addLeads(leads, tWaveLeads(tt, 0.92, -0.28, 0.04));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Failure to capture",
    active: [],
    mark: "TP",
  };
  if ([0.12, 0.38, 0.64].some((s) => Math.abs(tt - s) < 0.04)) {
    meta = { phase: "Pacing spike · no capture", active: [], mark: "TP" };
  }
  if (tt >= 0.68 && tt < 0.88) {
    meta = { phase: "Spike with capture", active: ["purkinjeR", "purkinjeL", "myocardiumV"], mark: "QRS" };
  } else if (tt >= 0.88 && tt < 0.98) {
    meta = { phase: "Captured T wave", active: ["myocardiumV"], mark: "T" };
  }
  return pack(leads, meta);
}

function sampleFailureToSense(t: number): WaveSample {
  const tt = clamp01(t);
  // Intrinsic QRS ignored; spike lands on/after T (R-on-T risk teaching)
  let leads = addLeads(
    addLeads(pWaveLeads(tt, 0.08), qrsLeads(tt, 0.26)),
    tWaveLeads(tt, 0.48, 0.28, 0.04),
  );
  leads = addLeads(leads, paceSpike(tt, 0.52, 0.65));
  leads = addLeads(leads, pacedQrsLeads(tt, 0.58, 0.85));
  leads = addLeads(leads, tWaveLeads(tt, 0.82, -0.3, 0.045));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Undersensing", active: [], mark: "TP" };
  if (tt < 0.18) meta = { phase: "Intrinsic P", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  else if (tt < 0.4) {
    meta = {
      phase: "Intrinsic QRS (not sensed)",
      active: ["his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
      mark: "QRS",
    };
  } else if (tt < 0.55) meta = { phase: "Inappropriate pacing spike", active: [], mark: "QRS" };
  else if (tt < 0.75) meta = { phase: "Paced QRS after undersense", active: ["myocardiumV", "purkinjeR"], mark: "QRS" };
  else meta = { phase: "Repolarization", active: ["myocardiumV"], mark: "T" };
  return pack(leads, meta);
}

function sampleSinusPause(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  // Two sinus beats, long pause (not exact multiple), junctional escape, recovery
  for (const p of [0.06, 0.28]) {
    leads = addLeads(leads, addLeads(pWaveLeads(tt, p), qrsLeads(tt, p + 0.18)));
    leads = addLeads(leads, tWaveLeads(tt, p + 0.4, 0.24, 0.035));
  }
  // Pause 0.48–0.78, then escape (no P) then sinus resumes
  leads = addLeads(leads, qrsLeads(tt, 0.82, 0.026, 0.75));
  leads = addLeads(leads, tWaveLeads(tt, 0.95, 0.2, 0.03));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = { phase: "Sinus pause", active: [], mark: "TP" };
  if (tt < 0.45) {
    if (tt % 0.22 < 0.08) meta = { phase: "Sinus P–QRS", active: ["sa", "internodal", "av", "his", "myocardiumV"], mark: "P" };
    else meta = { phase: "Sinus rhythm", active: ["myocardiumV"], mark: "T" };
  } else if (tt < 0.78) meta = { phase: "Sinus pause / arrest · no P", active: [], mark: "TP" };
  else meta = { phase: "Escape beat", active: ["av", "his", "purkinjeL", "myocardiumV"], mark: "QRS" };
  return pack(leads, meta);
}

function sampleSaExitBlock(t: number): WaveSample {
  const tt = clamp01(t);
  // PP ≈ 0.28; dropped beat makes pause ≈ 0.56 (2×)
  const beats = [0.08, 0.36, /* drop at 0.64 */ 0.92];
  let leads = emptyLeads();
  for (const p of beats) {
    leads = addLeads(leads, addLeads(pWaveLeads(tt, p), qrsLeads(tt, p + 0.16)));
    leads = addLeads(leads, tWaveLeads(tt, p + 0.36, 0.22, 0.03));
  }
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "SA exit block",
    active: [],
    mark: "TP",
  };
  for (const p of beats) {
    if (Math.abs(tt - p) < 0.05) {
      meta = { phase: "Sinus P–QRS", active: ["sa", "internodal", "av", "his", "myocardiumV"], mark: "P" };
    }
  }
  if (tt > 0.55 && tt < 0.85) {
    meta = { phase: "Dropped beat · pause ≈ 2× PP", active: ["sa"], mark: "TP" };
  }
  return pack(leads, meta);
}

function sampleSickSinus(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();

  // Classic SSS strip: inappropriate sinus brady → sinus arrest → junctional escape → slow recovery
  // Beat 1–2: marked sinus bradycardia (long PP)
  for (const p of [0.04, 0.28]) {
    leads = addLeads(leads, pWaveLeads(tt, p, 0.15));
    leads = addLeads(leads, qrsLeads(tt, p + 0.16, 0.024, 0.9));
    leads = addLeads(leads, tWaveLeads(tt, p + 0.36, 0.24, 0.035));
  }

  // Sinus arrest: long flat pause (not an integer multiple of the basic PP)
  // Junctional escape (narrow QRS, no preceding P)
  leads = addLeads(leads, qrsLeads(tt, 0.72, 0.024, 0.7, -0.04, -0.12));
  leads = addLeads(leads, tWaveLeads(tt, 0.88, 0.2, 0.035));

  // Slow sinus resumes late
  leads = addLeads(leads, pWaveLeads(tt, 0.94, 0.12));

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Sick sinus syndrome",
    active: [],
    mark: "TP",
  };
  if (tt < 0.42) {
    if ([0.04, 0.28].some((p) => Math.abs(tt - p) < 0.05)) {
      meta = { phase: "Inappropriate sinus bradycardia", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
    } else if ([0.2, 0.44].some((q) => Math.abs(tt - q) < 0.05)) {
      meta = {
        phase: "Conducted QRS",
        active: ["av", "his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
        mark: "QRS",
      };
    } else {
      meta = { phase: "Slow sinus rhythm (SSS)", active: ["sa"], mark: "TP" };
    }
  } else if (tt < 0.68) {
    meta = { phase: "Sinus arrest · no P waves", active: [], mark: "TP" };
  } else if (tt < 0.9) {
    meta = { phase: "Junctional escape", active: ["av", "his", "purkinjeL", "myocardiumV"], mark: "QRS" };
  } else {
    meta = { phase: "Slow sinus recovery", active: ["sa", "internodal", "myocardiumA"], mark: "P" };
  }
  return pack(leads, meta);
}

function sampleTachyBrady(t: number): WaveSample {
  const tt = clamp01(t);
  let leads = emptyLeads();
  // Burst of irregular atrial tach / fib-like, then long pause, then slow sinus
  const fibW: Partial<Record<LeadId, number>> = {
    I: 0.2,
    II: 0.4,
    III: 0.35,
    aVR: -0.25,
    aVL: 0.1,
    aVF: 0.35,
    V1: 0.9,
    V2: 0.45,
    V3: 0.2,
    V4: 0.1,
    V5: 0.08,
    V6: 0.08,
  };
  if (tt < 0.42) {
    for (let i = 0; i < 8; i++) {
      const fib = Math.sin((tt * 28 + i * 1.4) * Math.PI * 2) * 0.04;
      leads = addLeads(leads, scaleLeads(fib, fibW));
    }
    for (const b of [0.06, 0.16, 0.24, 0.34]) {
      leads = addLeads(leads, qrsLeads(tt, b, 0.02, 0.85));
    }
  }
  // Long pause then slow sinus recovery
  if (tt > 0.78) {
    leads = addLeads(leads, addLeads(pWaveLeads(tt, 0.82, 0.14), qrsLeads(tt, 0.96, 0.022, 0.7)));
  }

  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Tachy–brady syndrome",
    active: [],
    mark: "TP",
  };
  if (tt < 0.42) {
    meta = {
      phase: "Atrial tachyarrhythmia burst",
      active: ["myocardiumA", "av", "his", "myocardiumV"],
      mark: tt < 0.38 && (tt * 20) % 1 < 0.4 ? "QRS" : "TP",
    };
  } else if (tt < 0.78) meta = { phase: "Post-conversion sinus pause", active: [], mark: "TP" };
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
  pvc: samplePvc,
  vt: sampleVt,
  vtMonoLbbb: sampleVtMonoLbbb,
  vtMonoRbbb: sampleVtMonoRbbb,
  vtPoly: sampleVtPoly,
  torsades: sampleTorsades,
  vf: sampleVf,
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
  if (from === "vf" || from === "torsades") return 7.8;
  if (from === "vt" || from === "vtMonoLbbb" || from === "vtMonoRbbb" || from === "vtPoly") return 7.2;
  if (from === "afib" || from === "aflutterCcw" || from === "aflutterCw") return 6.8;
  return 6.2;
}

/**
 * Continuous post-shock recovery → sinus.
 * Late portion crossfades into real NSR so handoff is seamless.
 * `t` is normalized over the recovery window (0…1).
 */
export function samplePostCardioversion(t: number, from: FindingId): WaveSample {
  const tt = Math.max(0, Math.min(1, t));
  let seed = 0;
  for (let i = 0; i < from.length; i++) seed = (seed * 33 + from.charCodeAt(i)) >>> 0;
  const rnd = (i: number) => {
    const x = Math.sin(seed * 0.001 + i * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  const jitter = (i: number, amt: number) => (rnd(i) - 0.5) * 2 * amt;

  const wasVFib = from === "vf" || from === "torsades" || from === "vtPoly";
  const wasVt = from.startsWith("vt") || from === "torsades";
  const wasAf = from === "afib" || from === "aflutterCcw" || from === "aflutterCw";

  // --- Build evolving recovery morphology (same timeline as blend target) ---
  let leads = emptyLeads();
  let meta: Pick<WaveSample, "phase" | "active" | "mark"> = {
    phase: "Post-shock · electrical silence",
    active: [],
    mark: "TP",
  };

  const stun = 0.012 * Math.sin(tt * 90 + seed) * Math.exp(-tt * 10);
  leads = addLeads(leads, scaleLeads(stun, { II: 1, V1: 0.55, V5: 0.45 }));

  // Continuous beat schedule: times increase, morphology narrows, P waves appear
  type RecBeat = {
    t: number;
    kind: "wide" | "junct" | "sinus";
    pLead?: number;
  };
  const beats: RecBeat[] = [];
  // Asystole ~0–0.10, then escapes → junctional → sinus
  if (wasVFib || wasVt) {
    beats.push({ t: 0.11 + jitter(1, 0.012), kind: "wide" });
  }
  beats.push({ t: 0.2 + jitter(2, 0.015), kind: wasVt ? "wide" : "junct" });
  beats.push({ t: 0.3 + jitter(3, 0.012), kind: "junct" });
  beats.push({ t: 0.4 + jitter(4, 0.01), kind: "junct", pLead: 0.04 });
  beats.push({ t: 0.5 + jitter(5, 0.01), kind: "sinus", pLead: 0.055 });
  beats.push({ t: 0.6 + jitter(6, 0.008), kind: "sinus", pLead: 0.06 });
  beats.push({ t: 0.7 + jitter(7, 0.006), kind: "sinus", pLead: 0.065 });
  beats.push({ t: 0.8 + jitter(8, 0.005), kind: "sinus", pLead: 0.07 });
  beats.push({ t: 0.9 + jitter(9, 0.004), kind: "sinus", pLead: 0.072 });

  if (wasVFib && tt < 0.08) {
    const rip =
      0.1 * Math.sin(tt * 240 + seed) * Math.exp(-tt * 55) +
      0.06 * Math.sin(tt * 330) * Math.exp(-tt * 65);
    leads = addLeads(leads, scaleLeads(rip, { II: 1, V1: 0.95, V2: 0.7 }));
    if (tt < 0.055) {
      meta = { phase: "Post-shock · fibrillatory residual decaying", active: ["myocardiumV"], mark: "QRS" };
    }
  } else if (tt < 0.1) {
    meta = { phase: "Post-shock asystole · myocardial stun", active: [], mark: "TP" };
  }

  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]!;
    const progress = i / Math.max(1, beats.length - 1); // 0 → 1 over recovery beats
    const widthScale = 1 - 0.55 * progress;
    const amp = 0.65 + 0.35 * progress;

    if (b.kind === "sinus" && b.pLead != null) {
      const pT = b.t - b.pLead;
      if (pT > 0.08) {
        leads = addLeads(leads, pWaveLeads(tt, pT, 0.1 + 0.08 * progress));
        if (Math.abs(tt - pT) < 0.028) {
          meta = {
            phase: progress < 0.7 ? "Emerging sinus P" : "Sinus P · stabilizing",
            active: ["sa", "internodal", "myocardiumA"],
            mark: "P",
          };
        }
      }
    }

    if (b.kind === "wide") {
      leads = addLeads(leads, wideQrsLeads(tt, b.t, amp * (0.75 + rnd(20 + i) * 0.2)));
      leads = addLeads(leads, tWaveLeads(tt, b.t + 0.12, -0.18, 0.035));
    } else {
      leads = addLeads(leads, qrsLeads(tt, b.t, 0.022 + 0.012 * widthScale, amp));
      leads = addLeads(leads, tWaveLeads(tt, b.t + 0.16 + 0.04 * progress, 0.18 + 0.1 * progress, 0.04));
    }

    if (Math.abs(tt - b.t) < 0.04) {
      if (b.kind === "wide") {
        meta = {
          phase: "Ventricular escape · post-shock",
          active: ["purkinjeL", "purkinjeR", "myocardiumV"],
          mark: "QRS",
        };
      } else if (b.kind === "junct") {
        meta = {
          phase: "Junctional escape · accelerating",
          active: ["av", "his", "rbb", "lbb", "purkinjeL", "purkinjeR", "myocardiumV"],
          mark: "QRS",
        };
      } else {
        meta = {
          phase: "Conducted sinus QRS · recovering",
          active: ["av", "his", "rbb", "lbb", "purkinjeR", "purkinjeL", "myocardiumV"],
          mark: "QRS",
        };
      }
    } else if (tt > b.t + 0.05 && tt < b.t + 0.16 && Math.abs(tt - b.t) < 0.2) {
      if (meta.mark === "TP" || meta.phase.includes("asystole") || meta.phase.includes("silence")) {
        meta = { phase: "Repolarization · recovery", active: ["myocardiumV"], mark: "T" };
      }
    }
  }

  if (wasAf && tt > 0.15 && tt < 0.45) {
    const fib =
      0.035 * (1 - smoothstep((tt - 0.15) / 0.3)) * Math.sin(tt * 130 + seed * 0.02);
    leads = addLeads(leads, scaleLeads(fib, { II: 1, V1: 1.15, aVF: 0.55 }));
  }

  const recovery: WaveSample = pack(leads, meta);

  // --- Crossfade into real NSR so the end state *is* sinus ---
  // NSR phase advances through ~2 cycles during the second half of recovery
  const nsrAnchor = 0.42;
  const nsrSpan = 1 - nsrAnchor;
  const nsrCycles = 2.15;
  const nsrT =
    tt <= nsrAnchor ? 0 : clamp01((((tt - nsrAnchor) / nsrSpan) * nsrCycles) % 1);
  const nsr = sampleWave("nsr", nsrT);
  // Soft labels while blending
  const nsrLabeled: WaveSample = {
    ...nsr,
    phase:
      tt < 0.75
        ? `Merging into sinus · ${nsr.phase}`
        : tt < 0.9
          ? `Sinus rhythm restoring · ${nsr.phase}`
          : nsr.phase,
  };

  // Blend starts mid-recovery and reaches full NSR before the window ends
  const blend = smoothstep((tt - 0.5) / 0.38); // 0 @0.50 → 1 @0.88
  if (blend <= 0.001) return recovery;
  if (blend >= 0.999) return nsrLabeled;
  return lerpWaveSample(recovery, nsrLabeled, blend);
}

/** NSR cycle phase at the end of a recovery window (for seamless handoff). */
export function cardioversionEndNsrPhase(): number {
  const nsrAnchor = 0.42;
  const nsrSpan = 1 - nsrAnchor;
  const nsrCycles = 2.15;
  return clamp01(((((1 - nsrAnchor) / nsrSpan) * nsrCycles) % 1));
}

/** Absolute-time NSR / recovery phase for conduction + strip continuity. */
export function cardioversionTCycle(
  elapsedSec: number,
  durationSec: number,
  nsrCycleSec: number,
): number {
  const nsrAnchor = 0.42;
  const nsrSpan = 1 - nsrAnchor;
  const nsrCycles = 2.15;
  const cycle = Math.max(0.25, nsrCycleSec);
  if (elapsedSec < durationSec) {
    const tt = Math.max(0, elapsedSec) / Math.max(0.001, durationSec);
    if (tt <= nsrAnchor) return tt; // progress through early recovery
    return clamp01((((tt - nsrAnchor) / nsrSpan) * nsrCycles) % 1);
  }
  const post = elapsedSec - durationSec;
  return clamp01(cardioversionEndNsrPhase() + post / cycle);
}

/**
 * Absolute-time cardioversion sampler: recovery arc, then unbroken NSR.
 * Negative times (strip lookback before the shock) stay silent.
 */
export function sampleCardioversionAt(
  tAbs: number,
  from: FindingId,
  durationSec: number,
  nsrCycleSec: number,
): WaveSample {
  if (tAbs <= 0) {
    return pack(emptyLeads(), {
      phase: "Pre-shock",
      active: [],
      mark: "TP",
    });
  }
  if (tAbs < durationSec) {
    return samplePostCardioversion(tAbs / durationSec, from);
  }
  return sampleWave("nsr", cardioversionTCycle(tAbs, durationSec, nsrCycleSec));
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
