import type { FindingId, SegmentId } from "./findings";

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

const ECTOPY_BRANCHES: BranchWindow[] = [
  { id: "purkinjeL", t0: 0.18, t1: 0.55, group: "ectopy" },
  { id: "purkinjeR", t0: 0.22, t1: 0.58, group: "ectopy" },
  { id: "lbbp", t0: 0.20, t1: 0.42, group: "ectopy" },
];

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

  // 2:1 AV conduction at same times as EKG QRS (0.18, 0.58)
  for (const q of [0.18, 0.58]) {
    out.push({ id: "av", t0: q - 0.06, t1: q - 0.02, group: "av-delay" });
    out.push({ id: "his", t0: q - 0.02, t1: q + 0.02, group: "his" });
    out.push({ id: "rbb", t0: q, t1: q + 0.08, group: "bundles" });
    out.push({ id: "lbb", t0: q, t1: q + 0.06, group: "bundles" });
    out.push({ id: "lbba", t0: q + 0.02, t1: q + 0.1, group: "fascicles" });
    out.push({ id: "lbbp", t0: q + 0.02, t1: q + 0.1, group: "fascicles" });
    out.push({ id: "purkinjeR", t0: q + 0.04, t1: q + 0.12, group: "purkinje" });
    out.push({ id: "purkinjeL", t0: q + 0.04, t1: q + 0.12, group: "purkinje" });
  }

  return out;
}

/** Chaotic multi-wavelet atrial activation (AFib) */
function afibBranches(): BranchWindow[] {
  const out: BranchWindow[] = [];
  // Multiple overlapping internodal fronts at staggered times
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
  // Irregular ventricular conduction matching sampleAfib QRS times
  for (const q of [0.06, 0.27, 0.41, 0.68, 0.91]) {
    out.push({ id: "av", t0: q - 0.04, t1: q, group: "av-delay" });
    out.push({ id: "his", t0: q, t1: q + 0.03, group: "his" });
    out.push({ id: "rbb", t0: q + 0.01, t1: q + 0.08, group: "bundles" });
    out.push({ id: "lbb", t0: q + 0.01, t1: q + 0.07, group: "bundles" });
    out.push({ id: "purkinjeR", t0: q + 0.03, t1: q + 0.1, group: "purkinje" });
    out.push({ id: "purkinjeL", t0: q + 0.03, t1: q + 0.1, group: "purkinje" });
  }
  return out;
}

export function branchesForFinding(finding: FindingId | string | undefined): BranchWindow[] {
  const base = NSR_BRANCHES.map((b) => ({ ...b }));

  if (finding === "aflutterCcw") return flutterCircuitBranches("ccw");
  if (finding === "aflutterCw") return flutterCircuitBranches("cw");
  if (finding === "afib") return afibBranches();

  if (finding === "rbbb") {
    for (const b of base) {
      if (b.id === "rbb" || b.id === "purkinjeR") {
        b.t0 += 0.05;
        b.t1 += 0.07;
      }
    }
  }
  if (finding === "lbbb" || finding === "pacedVentricular" || finding === "pacedDual") {
    for (const b of base) {
      if (b.id === "lbb" || b.id === "lbba" || b.id === "lbbp" || b.id === "purkinjeL") {
        b.t0 += 0.05;
        b.t1 += 0.07;
      }
    }
  }
  if (finding === "wpw") {
    base.push({ id: "accessory", t0: 0.14, t1: 0.30, group: "accessory" });
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
  if (finding === "av2i" || finding === "av2ii") {
    // Keep NSR atrial; ventricular only when conducted (glow still from EKG active)
  }
  if (finding === "av3") {
    // Dissociated: atrial NSR-like + separate escape ectopy windows
    return [
      { id: "sa", t0: 0.04, t1: 0.09, group: "pacemaker" },
      { id: "internodal", t0: 0.06, t1: 0.14, group: "atrial" },
      { id: "sa", t0: 0.28, t1: 0.33, group: "pacemaker" },
      { id: "internodal", t0: 0.3, t1: 0.38, group: "atrial" },
      { id: "sa", t0: 0.52, t1: 0.57, group: "pacemaker" },
      { id: "internodal", t0: 0.54, t1: 0.62, group: "atrial" },
      { id: "sa", t0: 0.76, t1: 0.81, group: "pacemaker" },
      { id: "internodal", t0: 0.78, t1: 0.86, group: "atrial" },
      { id: "purkinjeL", t0: 0.18, t1: 0.35, group: "ectopy" },
      { id: "purkinjeR", t0: 0.2, t1: 0.38, group: "ectopy" },
      { id: "purkinjeL", t0: 0.68, t1: 0.85, group: "ectopy" },
      { id: "purkinjeR", t0: 0.7, t1: 0.88, group: "ectopy" },
    ];
  }
  if (finding === "pacedAtrial") {
    for (const b of base) {
      if (b.id === "sa") {
        b.t0 = 0.06;
        b.t1 = 0.14;
      }
    }
  }
  if (
    finding === "vt" ||
    finding === "vtMonoLbbb" ||
    finding === "vtMonoRbbb" ||
    finding === "vtPoly" ||
    finding === "torsades" ||
    finding === "vf" ||
    finding === "failureToCapture"
  ) {
    return ECTOPY_BRANCHES.map((b) => ({ ...b }));
  }
  if (finding === "pvc" || finding === "failureToSense") {
    return [
      ...base,
      { id: "purkinjeL", t0: 0.55, t1: 0.75, group: "ectopy" },
      { id: "purkinjeR", t0: 0.58, t1: 0.78, group: "ectopy" },
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
  if (finding === "sinusPause" || finding === "saExitBlock" || finding === "sickSinus") {
    // Slow / interrupted SA — keep SA+internodal but stretch
    return [
      { id: "sa", t0: 0.04, t1: 0.1, group: "pacemaker" },
      { id: "internodal", t0: 0.06, t1: 0.16, group: "atrial" },
      { id: "av", t0: 0.16, t1: 0.24, group: "av-delay" },
      { id: "his", t0: 0.2, t1: 0.26, group: "his" },
      { id: "rbb", t0: 0.22, t1: 0.32, group: "bundles" },
      { id: "lbb", t0: 0.22, t1: 0.3, group: "bundles" },
      { id: "purkinjeR", t0: 0.26, t1: 0.38, group: "purkinje" },
      { id: "purkinjeL", t0: 0.26, t1: 0.38, group: "purkinje" },
      { id: "sa", t0: 0.28, t1: 0.34, group: "pacemaker" },
      { id: "internodal", t0: 0.3, t1: 0.4, group: "atrial" },
      { id: "av", t0: 0.4, t1: 0.48, group: "av-delay" },
      { id: "his", t0: 0.44, t1: 0.5, group: "his" },
      { id: "purkinjeR", t0: 0.48, t1: 0.58, group: "purkinje" },
      { id: "purkinjeL", t0: 0.48, t1: 0.58, group: "purkinje" },
      // pause then escape / recovery
      { id: "av", t0: 0.7, t1: 0.78, group: "av-delay" },
      { id: "his", t0: 0.74, t1: 0.82, group: "his" },
      { id: "purkinjeL", t0: 0.78, t1: 0.92, group: "ectopy" },
      { id: "sa", t0: 0.92, t1: 0.98, group: "pacemaker" },
    ];
  }
  if (finding === "tachyBrady") {
    return [
      ...afibBranches().filter((b) => b.t1 <= 0.45),
      { id: "sa", t0: 0.8, t1: 0.88, group: "pacemaker" },
      { id: "internodal", t0: 0.82, t1: 0.92, group: "atrial" },
      { id: "av", t0: 0.9, t1: 0.96, group: "av-delay" },
      { id: "his", t0: 0.94, t1: 0.99, group: "his" },
      { id: "purkinjeR", t0: 0.95, t1: 1.0, group: "purkinje" },
      { id: "purkinjeL", t0: 0.95, t1: 1.0, group: "purkinje" },
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
      return ["av-delay", "accessory"];
    case "QRS":
      return ["his", "bundles", "fascicles", "purkinje", "ectopy", "accessory"];
    case "ST":
    case "T":
      // Myocardial recovery spans the same ventricular mass that was activated
      return ["his", "bundles", "fascicles", "purkinje", "ectopy", "accessory"];
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
