import type { FindingId, SegmentId } from "./findings";
import {
  classifyBundleBlocks,
  type BundleBlockId,
} from "./branchBlock";

/** Physiologic activation window along one pathway branch (normalized cycle) */
export type BranchWindow = {
  id: SegmentId;
  curveIndex?: number;
  t0: number;
  t1: number;
  group: string;
  /** Traverse the path from end→start (for CW flutter, etc.) */
  reverse?: boolean;
  /** Optional parametric start along the curve (default 0, or 1 if reverse) */
  u0?: number;
  /** Optional parametric end along the curve (default 1, or 0 if reverse) */
  u1?: number;
};

/**
 * Schedule aligned to NSR EKG marks:
 * P ~0.05–0.16 · PR ~0.16–0.28 · QRS ~0.28–0.42 · ST ~0.42–0.50 · T ~0.50–0.70
 */
export const NSR_BRANCHES: BranchWindow[] = [
  { id: "sa", t0: 0.05, t1: 0.10, group: "pacemaker" },
  { id: "internodal", t0: 0.08, t1: 0.17, group: "atrial" },
  { id: "av", t0: 0.16, t1: 0.28, group: "av-delay" },
  { id: "his", t0: 0.28, t1: 0.32, group: "his" },
  { id: "rbb", t0: 0.31, t1: 0.40, group: "bundles" },
  { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
  { id: "lbba", t0: 0.34, t1: 0.42, group: "fascicles" },
  { id: "lbbp", t0: 0.34, t1: 0.43, group: "fascicles" },
  { id: "purkinjeR", t0: 0.37, t1: 0.48, group: "purkinje" },
  { id: "purkinjeL", t0: 0.36, t1: 0.48, group: "purkinje" },
];

function ventCascade(q: number, opts?: { lDelay?: number; rDelay?: number }): BranchWindow[] {
  const l = opts?.lDelay ?? 0;
  const r = opts?.rDelay ?? 0;
  return [
    { id: "av", t0: q - 0.05, t1: q - 0.015, group: "av-delay" },
    { id: "his", t0: q - 0.015, t1: q + 0.025, group: "his" },
    { id: "rbb", t0: q + r, t1: q + 0.07 + r, group: "bundles" },
    { id: "lbb", t0: q + l, t1: q + 0.06 + l, group: "bundles" },
    { id: "lbba", t0: q + 0.02 + l, t1: q + 0.09 + l, group: "fascicles" },
    { id: "lbbp", t0: q + 0.02 + l, t1: q + 0.09 + l, group: "fascicles" },
    { id: "purkinjeR", t0: q + 0.03 + r, t1: q + 0.11 + r, group: "purkinje" },
    { id: "purkinjeL", t0: q + 0.03 + l, t1: q + 0.11 + l, group: "purkinje" },
  ];
}

function atrialAt(p: number): BranchWindow[] {
  return [
    { id: "sa", t0: p, t1: p + 0.05, group: "pacemaker" },
    { id: "internodal", t0: p + 0.015, t1: p + 0.09, group: "atrial" },
  ];
}

/**
 * CTI flutter ring curveIndex order (see conductionAnatomy PATHS):
 * 0 CTI (lateral→medial) · 1 septal ascending · 2 RA roof · 3 crista descending
 * Typical CCW: 0 → 1 → 2 → 3 → 0
 * CW: reverse each segment and reverse order
 */
const FLUTTER_RING_CCW = [0, 1, 2, 3] as const;
const FLUTTER_RING_CW = [3, 2, 1, 0] as const;

function flutterCircuitBranches(dir: "ccw" | "cw"): BranchWindow[] {
  const lap = 0.2; // 5 F waves / cycle · ~300/min
  const f0 = 0.04;
  const ring = dir === "ccw" ? FLUTTER_RING_CCW : FLUTTER_RING_CW;
  const reverse = dir === "cw";
  const out: BranchWindow[] = [];

  for (let lapI = 0; lapI < 5; lapI++) {
    const base = f0 + lapI * lap;
    const segDur = lap / ring.length;
    for (let s = 0; s < ring.length; s++) {
      out.push({
        id: "flutter",
        curveIndex: ring[s],
        t0: base + s * segDur,
        t1: base + (s + 1) * segDur,
        group: "atrial",
        reverse,
      });
    }
  }

  // 2:1 AV conduction — windows match EKG QRS mark [q−0.02, q+0.11]
  for (const q of [0.18, 0.58]) {
    out.push(...ventCascade(q));
  }

  return out;
}

/** Chaotic multi-wavelet atrial activation (AFib) — no SA pacemaker activity */
function afibBranches(): BranchWindow[] {
  const out: BranchWindow[] = [];
  // Wavelets on atrial pathways only (never "sa")
  const seeds = [
    { ci: 0, t0: 0.0, dur: 0.22 },
    { ci: 1, t0: 0.08, dur: 0.2 },
    { ci: 2, t0: 0.15, dur: 0.25 },
    { ci: 3, t0: 0.28, dur: 0.22 },
    { ci: 0, t0: 0.4, dur: 0.2 },
    { ci: 4, t0: 0.48, dur: 0.18 },
    { ci: 1, t0: 0.55, dur: 0.22 },
    { ci: 3, t0: 0.7, dur: 0.2 },
    { ci: 2, t0: 0.82, dur: 0.2 },
  ];
  for (const s of seeds) {
    out.push({
      id: "internodal",
      curveIndex: s.ci,
      t0: s.t0,
      t1: Math.min(1, s.t0 + s.dur),
      group: "atrial",
    });
  }
  for (const q of [0.18, 0.72, 1.15, 1.95, 2.7].map((sec) => sec / 3.33)) {
    // AV→His→ventricles only — no SA/atrialAt
    out.push({ id: "av", t0: q - 0.03, t1: q - 0.01, group: "av-delay" });
    out.push({ id: "his", t0: q - 0.01, t1: q + 0.02, group: "his" });
    out.push({ id: "rbb", t0: q, t1: q + 0.04, group: "bundles" });
    out.push({ id: "lbb", t0: q, t1: q + 0.04, group: "bundles" });
    out.push({ id: "lbba", t0: q + 0.01, t1: q + 0.05, group: "fascicles" });
    out.push({ id: "lbbp", t0: q + 0.01, t1: q + 0.05, group: "fascicles" });
    out.push({ id: "purkinjeR", t0: q + 0.015, t1: q + 0.06, group: "purkinje" });
    out.push({ id: "purkinjeL", t0: q + 0.015, t1: q + 0.06, group: "purkinje" });
  }
  return out;
}

function av2iBranches(): BranchWindow[] {
  // Must match sampleAv2i absolute → normalized events (CYCLE = 3.2 s)
  const CYCLE = 3.2;
  const abs: { p: number; qrs: number | null }[] = [
    { p: 0.08, qrs: 0.08 + 0.18 },
    { p: 0.88, qrs: 0.88 + 0.26 },
    { p: 1.68, qrs: 1.68 + 0.36 },
    { p: 2.48, qrs: null },
  ];
  const out: BranchWindow[] = [];
  for (const e of abs) {
    const p = e.p / CYCLE;
    const qrs = e.qrs == null ? null : e.qrs / CYCLE;
    out.push(...atrialAt(p));
    out.push({
      id: "av",
      t0: p + 0.02,
      t1: qrs ?? p + 0.05,
      group: "av-delay",
    });
    if (qrs != null) out.push(...ventCascade(qrs));
  }
  return out;
}

function av2iiBranches(): BranchWindow[] {
  const CYCLE = 2.52;
  const abs: { p: number; qrs: number | null }[] = [
    { p: 0.1, qrs: 0.1 + 0.18 },
    { p: 0.94, qrs: null },
    { p: 1.78, qrs: 1.78 + 0.18 },
  ];
  const out: BranchWindow[] = [];
  for (const e of abs) {
    const p = e.p / CYCLE;
    const qrs = e.qrs == null ? null : e.qrs / CYCLE;
    out.push(...atrialAt(p));
    if (qrs != null) {
      out.push({ id: "av", t0: p + 0.015, t1: qrs - 0.01, group: "av-delay" });
      out.push(...ventCascade(qrs));
    } else {
      out.push({ id: "av", t0: p + 0.015, t1: p + 0.05, group: "av-delay" });
      out.push({ id: "his", t0: p + 0.04, t1: p + 0.07, group: "his" });
    }
  }
  return out;
}

function atrialHisBase(): BranchWindow[] {
  return [
    { id: "sa", t0: 0.05, t1: 0.1, group: "pacemaker" },
    { id: "internodal", t0: 0.08, t1: 0.17, group: "atrial" },
    { id: "av", t0: 0.16, t1: 0.28, group: "av-delay" },
    { id: "his", t0: 0.28, t1: 0.32, group: "his" },
  ];
}

/** Pathway schedule for a custom / preset His–Purkinje lesion set */
export function branchesFromBundleBlocks(blocks: Iterable<BundleBlockId>): BranchWindow[] {
  const pattern = classifyBundleBlocks(blocks);

  if (pattern === "nsr") {
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.31, t1: 0.4, group: "bundles" },
      { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
      { id: "lbba", t0: 0.34, t1: 0.42, group: "fascicles" },
      { id: "lbbp", t0: 0.34, t1: 0.43, group: "fascicles" },
      { id: "purkinjeR", t0: 0.37, t1: 0.48, group: "purkinje" },
      { id: "purkinjeL", t0: 0.36, t1: 0.48, group: "purkinje" },
    ];
  }

  if (pattern === "trifascicular") {
    return [
      { id: "sa", t0: 0.04, t1: 0.09, group: "pacemaker" },
      { id: "internodal", t0: 0.055, t1: 0.13, group: "atrial" },
      { id: "sa", t0: 0.28, t1: 0.33, group: "pacemaker" },
      { id: "internodal", t0: 0.3, t1: 0.38, group: "atrial" },
      { id: "sa", t0: 0.52, t1: 0.57, group: "pacemaker" },
      { id: "internodal", t0: 0.54, t1: 0.62, group: "atrial" },
      { id: "sa", t0: 0.76, t1: 0.81, group: "pacemaker" },
      { id: "internodal", t0: 0.78, t1: 0.86, group: "atrial" },
      { id: "purkinjeL", t0: 0.2, t1: 0.38, group: "ectopy" },
      { id: "purkinjeR", t0: 0.24, t1: 0.4, group: "ectopy" },
      { id: "purkinjeL", t0: 0.7, t1: 0.88, group: "ectopy" },
      { id: "purkinjeR", t0: 0.74, t1: 0.9, group: "ectopy" },
    ];
  }

  if (pattern === "lbbb") {
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.31, t1: 0.4, group: "bundles" },
      { id: "purkinjeR", t0: 0.35, t1: 0.46, group: "purkinje" },
      { id: "lbb", t0: 0.42, t1: 0.54, group: "transseptal", u0: 0.5 },
      { id: "lbba", t0: 0.44, t1: 0.56, group: "fascicles" },
      { id: "lbbp", t0: 0.44, t1: 0.56, group: "fascicles" },
      { id: "purkinjeL", t0: 0.46, t1: 0.58, group: "purkinje" },
    ];
  }

  if (pattern === "rbbb") {
    return [
      ...atrialHisBase(),
      { id: "lbb", t0: 0.31, t1: 0.38, group: "bundles" },
      { id: "lbba", t0: 0.33, t1: 0.42, group: "fascicles" },
      { id: "lbbp", t0: 0.33, t1: 0.42, group: "fascicles" },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje" },
      { id: "rbb", t0: 0.4, t1: 0.52, group: "transseptal", u0: 0.45 },
      { id: "purkinjeR", t0: 0.44, t1: 0.56, group: "purkinje" },
    ];
  }

  if (pattern === "lafb") {
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.31, t1: 0.4, group: "bundles" },
      { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
      { id: "lbbp", t0: 0.33, t1: 0.42, group: "fascicles" },
      { id: "purkinjeR", t0: 0.36, t1: 0.46, group: "purkinje" },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje" },
      { id: "lbba", t0: 0.4, t1: 0.5, group: "transseptal", u0: 0.4 },
    ];
  }

  if (pattern === "lpfb") {
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.31, t1: 0.4, group: "bundles" },
      { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
      { id: "lbba", t0: 0.33, t1: 0.42, group: "fascicles" },
      { id: "purkinjeR", t0: 0.36, t1: 0.46, group: "purkinje" },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje" },
      { id: "lbbp", t0: 0.4, t1: 0.5, group: "transseptal", u0: 0.4 },
    ];
  }

  if (pattern === "rbbbLafb") {
    return [
      ...atrialHisBase(),
      { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
      { id: "lbbp", t0: 0.33, t1: 0.42, group: "fascicles" },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje" },
      { id: "lbba", t0: 0.42, t1: 0.52, group: "transseptal", u0: 0.4 },
      { id: "rbb", t0: 0.42, t1: 0.54, group: "transseptal", u0: 0.45 },
      { id: "purkinjeR", t0: 0.46, t1: 0.58, group: "purkinje" },
    ];
  }

  // rbbbLpfb
  return [
    ...atrialHisBase(),
    { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
    { id: "lbba", t0: 0.33, t1: 0.42, group: "fascicles" },
    { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje" },
    { id: "lbbp", t0: 0.42, t1: 0.52, group: "transseptal", u0: 0.4 },
    { id: "rbb", t0: 0.42, t1: 0.54, group: "transseptal", u0: 0.45 },
    { id: "purkinjeR", t0: 0.46, t1: 0.58, group: "purkinje" },
  ];
}

export function branchesForFinding(finding: FindingId | string | undefined): BranchWindow[] {
  const base = NSR_BRANCHES.map((b) => ({ ...b }));

  if (finding === "aflutterCcw") return flutterCircuitBranches("ccw");
  if (finding === "aflutterCw") return flutterCircuitBranches("cw");
  if (finding === "afib") return afibBranches();
  if (finding === "sinusTachy") {
    return [
      { id: "sa", t0: 0.04, t1: 0.1, group: "pacemaker" },
      { id: "internodal", t0: 0.06, t1: 0.14, group: "atrial" },
      { id: "av", t0: 0.14, t1: 0.22, group: "av-delay" },
      { id: "his", t0: 0.22, t1: 0.26, group: "his" },
      { id: "rbb", t0: 0.24, t1: 0.34, group: "bundles" },
      { id: "lbb", t0: 0.24, t1: 0.32, group: "bundles" },
      { id: "lbba", t0: 0.26, t1: 0.35, group: "fascicles" },
      { id: "lbbp", t0: 0.26, t1: 0.35, group: "fascicles" },
      { id: "purkinjeR", t0: 0.28, t1: 0.36, group: "purkinje" },
      { id: "purkinjeL", t0: 0.28, t1: 0.36, group: "purkinje" },
    ];
  }

  if (finding === "avnrt") {
    // Typical slow–fast: anterograde slow → His–Purkinje; retrograde fast → atria
    return [
      { id: "avnrtSlow", t0: 0.0, t1: 0.16, group: "avnrt" },
      { id: "av", t0: 0.1, t1: 0.18, group: "av-delay" },
      { id: "his", t0: 0.14, t1: 0.22, group: "his" },
      { id: "rbb", t0: 0.18, t1: 0.3, group: "bundles" },
      { id: "lbb", t0: 0.18, t1: 0.28, group: "bundles" },
      { id: "lbba", t0: 0.2, t1: 0.3, group: "fascicles" },
      { id: "lbbp", t0: 0.2, t1: 0.3, group: "fascicles" },
      { id: "purkinjeR", t0: 0.22, t1: 0.34, group: "purkinje" },
      { id: "purkinjeL", t0: 0.22, t1: 0.34, group: "purkinje" },
      // Fast pathway retrograde: compact node → Todaro (curve 0), then atrial exit (curve 1)
      { id: "avnrtFast", curveIndex: 0, t0: 0.2, t1: 0.32, group: "avnrt", reverse: true },
      { id: "avnrtFast", curveIndex: 1, t0: 0.26, t1: 0.38, group: "avnrt" },
      { id: "internodal", t0: 0.28, t1: 0.4, group: "atrial", reverse: true },
      { id: "sa", t0: 0.32, t1: 0.4, group: "pacemaker", reverse: true },
    ];
  }

  if (finding === "asystole") {
    return [];
  }

  if (finding === "rbbb") return branchesFromBundleBlocks(["rbb"]);
  if (finding === "lbbb") return branchesFromBundleBlocks(["lbb"]);
  if (finding === "lafb") return branchesFromBundleBlocks(["lbba"]);
  if (finding === "lpfb") return branchesFromBundleBlocks(["lbbp"]);
  if (finding === "rbbbLafb") return branchesFromBundleBlocks(["rbb", "lbba"]);
  if (finding === "rbbbLpfb") return branchesFromBundleBlocks(["rbb", "lbbp"]);

  if (finding === "pacedVentricular") {
    // Spike @ 0.22 — capture after spike only
    return [
      { id: "purkinjeR", t0: 0.24, t1: 0.48, group: "ectopy" },
      { id: "rbb", t0: 0.26, t1: 0.44, group: "ectopy", reverse: true },
      { id: "purkinjeL", t0: 0.34, t1: 0.52, group: "ectopy" },
      { id: "lbb", t0: 0.36, t1: 0.5, group: "ectopy", reverse: true, u0: 0.4 },
    ];
  }
  if (finding === "pacedDual") {
    // A spike 0.08 · V spike 0.28 — ventricular tracts after V spike
    return [
      ...atrialAt(0.08),
      { id: "av", t0: 0.18, t1: 0.28, group: "av-delay" },
      { id: "purkinjeR", t0: 0.3, t1: 0.52, group: "ectopy" },
      { id: "rbb", t0: 0.32, t1: 0.48, group: "ectopy", reverse: true },
      { id: "purkinjeL", t0: 0.36, t1: 0.54, group: "ectopy" },
    ];
  }
  if (finding === "pacedLbap") {
    // LBAP spike @ 0.26
    return [
      ...atrialAt(0.08),
      { id: "av", t0: 0.18, t1: 0.26, group: "av-delay" },
      { id: "lbb", t0: 0.28, t1: 0.42, group: "ectopy", u0: 0.35 },
      { id: "lbba", t0: 0.3, t1: 0.44, group: "fascicles" },
      { id: "lbbp", t0: 0.3, t1: 0.44, group: "fascicles" },
      { id: "purkinjeL", t0: 0.32, t1: 0.48, group: "purkinje" },
      { id: "his", t0: 0.3, t1: 0.38, group: "his", reverse: true },
      { id: "rbb", t0: 0.34, t1: 0.46, group: "bundles" },
      { id: "purkinjeR", t0: 0.36, t1: 0.5, group: "purkinje" },
    ];
  }
  if (finding === "pacedBiv") {
    // BiV spike @ 0.27
    return [
      ...atrialAt(0.08),
      { id: "av", t0: 0.18, t1: 0.27, group: "av-delay" },
      { id: "purkinjeR", t0: 0.3, t1: 0.5, group: "ectopy" },
      { id: "purkinjeL", t0: 0.3, t1: 0.5, group: "ectopy" },
      { id: "rbb", t0: 0.32, t1: 0.46, group: "ectopy", reverse: true },
      { id: "lbb", t0: 0.32, t1: 0.46, group: "ectopy", reverse: true },
    ];
  }
  if (finding === "wpw") {
    base.push({ id: "accessory", t0: 0.14, t1: 0.3, group: "accessory" });
    for (const b of base) {
      if (b.group === "bundles" || b.group === "fascicles" || b.group === "purkinje") {
        b.t0 -= 0.02;
        b.t1 -= 0.01;
      }
    }
  }
  if (finding === "av1") {
    for (const b of base) {
      if (b.id === "av") b.t1 += 0.08;
      if (b.group === "his" || b.group === "bundles" || b.group === "fascicles" || b.group === "purkinje") {
        b.t0 += 0.08;
        b.t1 += 0.08;
      }
    }
  }
  if (finding === "av2i") return av2iBranches();
  if (finding === "av2ii") return av2iiBranches();
  if (finding === "av3Junctional") {
    // Supra-His complete block · narrow junctional / His escape (CYCLE 2.67 s)
    const CYCLE = 2.67;
    const atr = [0.1, 0.77, 1.43, 2.1].map((s) => s / CYCLE);
    const esc = [0.45, 1.78].map((s) => s / CYCLE);
    const out: BranchWindow[] = [];
    for (const p of atr) out.push(...atrialAt(p));
    for (const q of esc) {
      out.push({ id: "his", t0: q - 0.03, t1: q + 0.02, group: "ectopy" });
      out.push(...ventCascade(q));
    }
    return out;
  }
  if (finding === "av3") {
    // Infra-His complete block · wide ventricular escape (CYCLE 3.33 s)
    const CYCLE = 3.33;
    const atr = [0.12, 0.78, 1.45, 2.11, 2.78].map((s) => s / CYCLE);
    const esc = [0.5, 2.17].map((s) => s / CYCLE);
    const out: BranchWindow[] = [];
    for (const p of atr) out.push(...atrialAt(p));
    for (const q of esc) {
      out.push({ id: "purkinjeL", t0: q - 0.02, t1: q + 0.08, group: "ectopy" });
      out.push({ id: "purkinjeR", t0: q - 0.01, t1: q + 0.09, group: "ectopy" });
    }
    return out;
  }
  if (finding === "pacedAtrial") {
    // Spike @ 0.08 — atrial capture afterward
    return [
      { id: "sa", t0: 0.1, t1: 0.18, group: "pacemaker" },
      { id: "internodal", t0: 0.12, t1: 0.22, group: "atrial" },
      { id: "av", t0: 0.2, t1: 0.32, group: "av-delay" },
      { id: "his", t0: 0.32, t1: 0.36, group: "his" },
      { id: "rbb", t0: 0.34, t1: 0.44, group: "bundles" },
      { id: "lbb", t0: 0.34, t1: 0.42, group: "bundles" },
      { id: "lbba", t0: 0.36, t1: 0.46, group: "fascicles" },
      { id: "lbbp", t0: 0.36, t1: 0.46, group: "fascicles" },
      { id: "purkinjeR", t0: 0.4, t1: 0.52, group: "purkinje" },
      { id: "purkinjeL", t0: 0.39, t1: 0.52, group: "purkinje" },
    ];
  }
  if (finding === "vt" || finding === "vf") {
    return [
      { id: "purkinjeL", t0: 0.12, t1: 0.55, group: "ectopy" },
      { id: "purkinjeR", t0: 0.14, t1: 0.55, group: "ectopy" },
    ];
  }
  if (finding === "vtMonoLbbb") {
    // Exit toward RV → LBBB morphology
    return [
      { id: "rbb", t0: 0.1, t1: 0.45, group: "ectopy" },
      { id: "purkinjeR", t0: 0.12, t1: 0.55, group: "ectopy" },
      { id: "purkinjeL", t0: 0.28, t1: 0.52, group: "ectopy" },
    ];
  }
  if (finding === "vtMonoRbbb") {
    return [
      { id: "lbb", t0: 0.1, t1: 0.45, group: "ectopy" },
      { id: "purkinjeL", t0: 0.12, t1: 0.55, group: "ectopy" },
      { id: "purkinjeR", t0: 0.28, t1: 0.52, group: "ectopy" },
    ];
  }
  if (finding === "vtPoly" || finding === "torsades") {
    const beats = [0.08, 0.24, 0.41, 0.57, 0.74, 0.9];
    const out: BranchWindow[] = [];
    for (let i = 0; i < beats.length; i++) {
      const q = beats[i]!;
      const left = i % 2 === 0;
      out.push({
        id: left ? "purkinjeL" : "purkinjeR",
        t0: Math.max(0, q - 0.03),
        t1: Math.min(1, q + 0.1),
        group: "ectopy",
      });
      out.push({
        id: left ? "lbb" : "rbb",
        t0: Math.max(0, q - 0.02),
        t1: Math.min(1, q + 0.08),
        group: "ectopy",
      });
    }
    return out;
  }
  if (finding === "failureToCapture") {
    // Spikes without capture stay dark; only the capturing beat lights ventricles
    return [
      { id: "purkinjeR", t0: 0.68, t1: 0.88, group: "ectopy" },
      { id: "purkinjeL", t0: 0.7, t1: 0.9, group: "ectopy" },
    ];
  }
  if (finding === "pvc" || finding === "failureToSense") {
    return [
      ...base,
      { id: "purkinjeL", t0: 0.55, t1: 0.72, group: "ectopy" },
      { id: "purkinjeR", t0: 0.58, t1: 0.72, group: "ectopy" },
    ];
  }
  if (finding === "failureToPace") {
    return [
      { id: "purkinjeR", t0: 0.1, t1: 0.32, group: "ectopy" },
      { id: "purkinjeL", t0: 0.12, t1: 0.34, group: "ectopy" },
      { id: "purkinjeL", t0: 0.78, t1: 0.95, group: "ectopy" },
      { id: "purkinjeR", t0: 0.8, t1: 0.97, group: "ectopy" },
    ];
  }
  if (finding === "sinusPause") {
    return [
      ...atrialAt(0.04),
      ...ventCascade(0.22),
      ...atrialAt(0.28),
      ...ventCascade(0.46),
      // long pause then escape
      { id: "purkinjeL", t0: 0.78, t1: 0.92, group: "ectopy" },
      { id: "purkinjeR", t0: 0.8, t1: 0.94, group: "ectopy" },
    ];
  }
  if (finding === "saExitBlock") {
    return [
      ...atrialAt(0.05),
      ...ventCascade(0.24),
      // missing SA exit — no atrial/vent mid-cycle
      ...atrialAt(0.72),
      ...ventCascade(0.9),
    ];
  }
  if (finding === "sickSinus") {
    return [
      ...atrialAt(0.04),
      ...ventCascade(0.22),
      ...atrialAt(0.35),
      ...ventCascade(0.52),
      { id: "purkinjeL", t0: 0.78, t1: 0.92, group: "ectopy" },
      { id: "sa", t0: 0.92, t1: 0.98, group: "pacemaker" },
    ];
  }
  if (finding === "tachyBrady") {
    return [
      ...afibBranches().filter((b) => b.t1 <= 0.45),
      ...atrialAt(0.8),
      ...ventCascade(0.96),
    ];
  }

  return base;
}

export type PathwayProbePoint = {
  pos: [number, number, number];
  tangent: [number, number, number];
  segmentId: SegmentId;
  color: number;
  pathU: number;
  enterT: number;
  exitT: number;
};

/** Instantaneous impulse front on one anatomic tract (travel direction included) */
export type ActiveFront = {
  id: SegmentId;
  pos: [number, number, number];
  /** Unit vector in the direction current is traveling */
  dir: [number, number, number];
  color: number;
  /** Progress through this branch window 0–1 */
  progress: number;
};

/** Map EKG cycle mark → expected conduction groups */
export function groupsForMark(mark: string): string[] {
  switch (mark) {
    case "P":
      return ["pacemaker", "atrial"];
    case "PR":
      return ["av-delay", "accessory", "avnrt"];
    case "QRS":
      return ["his", "bundles", "fascicles", "purkinje", "ectopy", "accessory", "transseptal", "avnrt"];
    case "ST":
    case "T":
      // Myocardial recovery spans the same ventricular mass that was activated
      return ["his", "bundles", "fascicles", "purkinje", "ectopy", "accessory", "transseptal"];
    default:
      return [];
  }
}

/**
 * Effective refractory period after a segment finishes activating,
 * as a fraction of the display cycle (teaching approximation).
 * Tissue stays slightly lit until this elapses (can conduct again).
 */
export function refractoryFrac(id: SegmentId): number {
  switch (id) {
    case "sa":
    case "internodal":
    case "myocardiumA":
      return 0.22;
    case "flutter":
      // Short — circuit reenters each F wave (~0.2 cycle)
      return 0.09;
    case "avnrtSlow":
    case "avnrtFast":
      return 0.12;
    case "av":
      return 0.36;
    case "his":
      return 0.28;
    case "rbb":
    case "lbb":
    case "lbba":
    case "lbbp":
      return 0.3;
    case "purkinjeR":
    case "purkinjeL":
    case "myocardiumV":
      return 0.34;
    case "accessory":
      return 0.26;
    default:
      return 0.25;
  }
}

/** 1 = conducting now, (0,1) = refractory afterglow, 0 = recovered */
export function refractoryGlow(
  tCycle: number,
  branches: BranchWindow[],
  id: SegmentId,
  curveIndex?: number,
): number {
  const t = ((tCycle % 1) + 1) % 1;
  let best = 0;

  for (const b of branches) {
    if (b.id !== id) continue;
    if (b.curveIndex != null && curveIndex != null && b.curveIndex !== curveIndex) continue;

    if (t >= b.t0 && t <= b.t1) {
      best = Math.max(best, 1);
      continue;
    }

    const ref = refractoryFrac(b.id);
    if (ref <= 0) continue;

    let since = -1;
    const refEnd = b.t1 + ref;
    if (refEnd <= 1) {
      if (t > b.t1 && t < refEnd) since = t - b.t1;
    } else if (t > b.t1) {
      since = t - b.t1;
    } else if (t < refEnd - 1) {
      since = 1 - b.t1 + t;
    }

    if (since >= 0 && since < ref) {
      const u = since / ref;
      // Strong just after activation, fades toward recovery
      best = Math.max(best, 0.55 * (1 - u * 0.7));
    }
  }

  return best;
}

/** Map AV-block findings → where conduction fails relative to the His bundle */
export function blockSiteForFinding(
  finding: string | undefined,
): "none" | "supra-his" | "infra-his" {
  switch (finding) {
    case "av1":
    case "av2i":
    case "av3Junctional":
      return "supra-his";
    case "av2ii":
    case "av3":
      return "infra-his";
    default:
      return "none";
  }
}
