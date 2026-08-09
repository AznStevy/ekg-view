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

/** LV Purkinje curve indices fed by the left anterior fascicle (see PATHS order).
 *  0 apex · 1 mid-lateral · 2 anterolateral base (Kent)
 */
export const PURKINJE_L_LAF_CURVES = new Set([0, 1, 2]);
/** LV Purkinje curve indices fed by the left posterior fascicle (outward free-wall fan).
 *  3 inferior apex · 4 mid lateral · 5 posterolateral · 6 posterior base
 */
export const PURKINJE_L_LPF_CURVES = new Set([3, 4, 5, 6]);
/** LV septal Purkinje (from LBB septal branch tip) — intact whenever LBB itself is up,
 *  including isolated LAFB / LPFB (not part of either free-wall fascicle fan). */
export const PURKINJE_L_SEPTAL_CURVES = new Set([7]);

/**
 * Schedule aligned to NSR EKG marks / waveform:
 * P ~0.05–0.15 · PR/AV ~0.15–0.22 · His–Purkinje ~0.22–0.31.
 * The intact myocardial field reaches full ventricular involvement at the
 * main QRS peak (~0.32), then remains visible through the rest of QRS.
 * Windows are sequential at junctions so balls don't light before upstream arrives.
 */
export const NSR_BRANCHES: BranchWindow[] = [
  { id: "sa", t0: 0.05, t1: 0.1, group: "pacemaker" },
  { id: "internodal", t0: 0.09, t1: 0.15, group: "atrial" },
  { id: "av", t0: 0.15, t1: 0.22, group: "av-delay" },
  { id: "his", t0: 0.22, t1: 0.24, group: "his" },
  { id: "rbb", t0: 0.24, t1: 0.26, group: "bundles" },
  { id: "lbb", t0: 0.24, t1: 0.26, group: "bundles" },
  { id: "lbba", t0: 0.26, t1: 0.28, group: "fascicles" },
  { id: "lbbp", t0: 0.26, t1: 0.28, group: "fascicles" },
  { id: "purkinjeR", t0: 0.28, t1: 0.305, group: "purkinje" },
  { id: "purkinjeL", t0: 0.28, t1: 0.305, group: "purkinje" },
];

/** Fraction of an upstream window that must elapse before the next tract may start.
 *  Near 1 so the ball is visually at the junction before the child lights. */
const HANDOFF_FRAC = 0.99;

/**
 * Same-segment curve sequencing (PATHS order).
 * RBB curve 0 = septal cord → apex; curve 1 = moderator band from apex.
 */
const INTRA_CURVE_GATE: Partial<
  Record<SegmentId, Record<number, { parentCurve: number; atU: number }>>
> = {
  rbb: {
    1: { parentCurve: 0, atU: 1 },
  },
};

/**
 * RV Purkinje takeoffs on the RBB tree (PATHS order for purkinjeR):
 * 0–1 from moderator tip · 2–3 from RBB apex · 4 from mid-septal RBB.
 */
const PURKINJE_R_ATTACH: Record<number, { parentCurve: number; atU: number }> = {
  0: { parentCurve: 1, atU: 1 },
  1: { parentCurve: 1, atU: 1 },
  2: { parentCurve: 0, atU: 1 },
  3: { parentCurve: 0, atU: 1 },
  /** RBB_MID is ~halfway along the main septal cord (5 control points) */
  4: { parentCurve: 0, atU: 0.5 },
};

/** LV septal Purkinje curve 7 starts at the tip of LBB curve 1 (septal branch). */
const PURKINJE_L_SEPTAL_ATTACH = {
  curveIndex: [...PURKINJE_L_SEPTAL_CURVES][0]!,
  parentCurve: 1,
  atU: 1,
} as const;

type EffectiveWindow = { t0: number; t1: number } | null;
const EFFECTIVE_WINDOW_CACHE = new WeakMap<
  BranchWindow[],
  WeakMap<BranchWindow, Map<string, EffectiveWindow>>
>();
const BRANCHES_BY_SEGMENT_CACHE = new WeakMap<
  BranchWindow[],
  Map<SegmentId, BranchWindow[]>
>();

function branchesBySegment(branches: BranchWindow[]): Map<SegmentId, BranchWindow[]> {
  const cached = BRANCHES_BY_SEGMENT_CACHE.get(branches);
  if (cached) return cached;
  const grouped = new Map<SegmentId, BranchWindow[]>();
  for (const branch of branches) {
    const list = grouped.get(branch.id) ?? [];
    list.push(branch);
    grouped.set(branch.id, list);
  }
  BRANCHES_BY_SEGMENT_CACHE.set(branches, grouped);
  return grouped;
}

/**
 * Anterograde parents for a segment (and optional Purkinje curve).
 * null = unconstrained · [] = no intact upstream (allow) · ids = wait for those.
 */
function anteParentsFor(
  id: SegmentId,
  curveIndex: number | undefined,
  lesions: Set<SegmentId>,
): SegmentId[] | null {
  switch (id) {
    case "internodal":
      return ["sa"];
    case "av":
      return ["internodal"];
    case "his":
      return ["av"];
    case "rbb":
    case "lbb":
      return ["his"];
    case "lbba":
      return ["lbb"];
    case "lbbp":
      return ["lbb"];
    case "purkinjeR":
      return ["rbb"];
    case "purkinjeL": {
      if (curveIndex === PURKINJE_L_SEPTAL_ATTACH.curveIndex) {
        return lesions.has("lbb") ? [] : ["lbb"];
      }
      // LAF rays wait for anterior fascicle — never unlock on LBB alone
      if (curveIndex != null && PURKINJE_L_LAF_CURVES.has(curveIndex)) {
        if (!lesions.has("lbba")) return ["lbba"];
        if (!lesions.has("lbb")) return ["lbb"];
        return [];
      }
      if (curveIndex != null && PURKINJE_L_LPF_CURVES.has(curveIndex)) {
        if (!lesions.has("lbbp")) return ["lbbp"];
        if (!lesions.has("lbb")) return ["lbb"];
        return [];
      }
      // Unspecified curve — require both fascicles when present
      const ps: SegmentId[] = [];
      if (!lesions.has("lbba")) ps.push("lbba");
      if (!lesions.has("lbbp")) ps.push("lbbp");
      if (!ps.length && !lesions.has("lbb")) ps.push("lbb");
      return ps;
    }
    // Anti down-Kent has no HPS parent; ortho reverse uses retroParentsFor
    case "accessory":
    case "accessoryR":
      return null;
    default:
      return null;
  }
}

/** Retrograde: distal source must arrive before this tract may travel back. */
function retroParentsFor(id: SegmentId): SegmentId[] | null {
  switch (id) {
    case "purkinjeL":
      return ["accessory"];
    case "purkinjeR":
      return ["accessoryR"];
    case "lbba":
    case "lbbp":
      return ["purkinjeL"];
    case "lbb":
      return ["lbba", "lbbp", "purkinjeL"];
    case "rbb":
      return ["purkinjeR"];
    case "his":
      return ["rbb", "lbb", "lbba", "lbbp"];
    case "av":
      return ["his", "accessory", "accessoryR"];
    case "internodal":
      return ["av"];
    case "sa":
      return ["internodal"];
    case "accessory":
      return ["purkinjeL"];
    case "accessoryR":
      return ["purkinjeR"];
    default:
      return null;
  }
}

/**
 * Distal-arrival time for one parent segment, using that parent's *effective*
 * window so delays propagate down the chain.
 *
 * `child` excludes later loop limbs of the same parent id (e.g. reverse Purkinje
 * must not wait for the *return* Kent window in antidromic AVRT).
 * `preferCurve` selects a tip / takeoff ray when the parent has parallel curves.
 */
function parentHandoffTime(
  parentId: SegmentId,
  branches: BranchWindow[],
  lesions: Set<SegmentId>,
  visited: Set<string>,
  child?: BranchWindow,
  preferCurve?: number,
): number | null {
  if (lesions.has(parentId)) return null;

  const collect = (requirePrecede: boolean): number | null => {
    let latest: number | null = null;
    for (const pb of branches) {
      if (pb.id !== parentId) continue;
      if (child && requirePrecede && pb.t0 > child.t0) continue;
      if (preferCurve != null && pb.curveIndex != null && pb.curveIndex !== preferCurve) {
        continue;
      }
      const evalCi = pb.curveIndex ?? preferCurve;
      const win = effectiveImpulseWindow(
        pb,
        branches,
        lesions,
        evalCi,
        new Set(visited),
      );
      if (!win) continue;
      const handoff = win.t0 + HANDOFF_FRAC * Math.max(1e-4, win.t1 - win.t0);
      if (latest == null || handoff > latest) latest = handoff;
    }
    return latest;
  };

  // Prefer parents that start before this child; fall back if schedule is inverted
  return collect(true) ?? collect(false);
}

/** When the impulse ball on a specific parent curve reaches parametric `atU`. */
function curveArrivalTime(
  parentId: SegmentId,
  parentCurve: number,
  atU: number,
  branches: BranchWindow[],
  lesions: Set<SegmentId>,
  visited: Set<string>,
  child?: BranchWindow,
): number | null {
  if (lesions.has(parentId)) return null;
  const u = Math.min(1, Math.max(0, atU));
  let latest: number | null = null;
  for (const pb of branches) {
    if (pb.id !== parentId) continue;
    if (pb.reverse) continue;
    if (child && pb.t0 > child.t0) continue;
    if (pb.curveIndex != null && pb.curveIndex !== parentCurve) continue;
    const win = effectiveImpulseWindow(
      pb,
      branches,
      lesions,
      parentCurve,
      new Set(visited),
    );
    if (!win) continue;
    const arrive = win.t0 + u * Math.max(1e-4, win.t1 - win.t0);
    if (latest == null || arrive > latest) latest = arrive;
  }
  return latest;
}

/** Kent–Purkinje tip curve indices (matches PATHS / AVRT schedules). */
const KENT_PURK_CURVE: Record<"accessory" | "accessoryR", number> = {
  accessory: 2,
  accessoryR: 0,
};

/**
 * Causal impulse window: child balls/glow cannot start until the correct upstream
 * tract has reached the junction. `curveIndex` selects LAF vs LPF Purkinje parents
 * and RBB / RV Purkinje takeoff sequencing.
 */
export function effectiveImpulseWindow(
  b: BranchWindow,
  branches: BranchWindow[],
  lesionIds?: Iterable<SegmentId>,
  curveIndex?: number,
  visited?: Set<string>,
): { t0: number; t1: number } | null {
  const lesions = lesionIds instanceof Set ? lesionIds : new Set(lesionIds ?? []);
  const ci = curveIndex ?? b.curveIndex;
  const topLevel = visited == null;
  const cacheKey = `${ci ?? "*"}|${[...lesions].sort().join(",")}`;
  if (topLevel) {
    const cached = EFFECTIVE_WINDOW_CACHE.get(branches)?.get(b)?.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const vKey = `${b.id}:${ci ?? "*"}:${b.reverse ? "r" : "a"}:${b.t0.toFixed(3)}`;
  const seen = visited ?? new Set<string>();
  if (seen.has(vKey)) {
    // Cycle guard — fall back to raw schedule
    return { t0: b.t0, t1: b.t1 };
  }
  seen.add(vKey);

  const rawSpan = Math.max(0.018, b.t1 - b.t0);
  let t0 = b.t0;

  /** AVRT/AVNRT schedules are tight loops — delay start only, don't push t1 or the
   *  cascade compounds and Kent/left Purkinje land after the EKG has left QRS/ST. */
  const compactLoop = branches.some(
    (x) =>
      x.id === "accessory" ||
      x.id === "accessoryR" ||
      x.id === "avnrtSlow" ||
      x.id === "avnrtFast",
  );

  // Same-segment sequencing (e.g. moderator band after main RBB tip)
  if (!b.reverse && ci != null) {
    const intra = INTRA_CURVE_GATE[b.id]?.[ci];
    if (intra) {
      const arrive = curveArrivalTime(
        b.id,
        intra.parentCurve,
        intra.atU,
        branches,
        lesions,
        seen,
        b,
      );
      if (arrive != null) t0 = Math.max(t0, arrive);
    }
  }

  // RV Purkinje: wait until RBB ball reaches this twig's anatomic takeoff
  if (
    !b.reverse &&
    b.id === "purkinjeL" &&
    ci === PURKINJE_L_SEPTAL_ATTACH.curveIndex
  ) {
    const arrive = curveArrivalTime(
      "lbb",
      PURKINJE_L_SEPTAL_ATTACH.parentCurve,
      PURKINJE_L_SEPTAL_ATTACH.atU,
      branches,
      lesions,
      seen,
      b,
    );
    if (arrive != null) t0 = Math.max(t0, arrive);
  } else if (!b.reverse && b.id === "purkinjeR" && ci != null && PURKINJE_R_ATTACH[ci]) {
    const gate = PURKINJE_R_ATTACH[ci]!;
    const arrive = curveArrivalTime(
      "rbb",
      gate.parentCurve,
      gate.atU,
      branches,
      lesions,
      seen,
      b,
    );
    if (arrive != null) t0 = Math.max(t0, arrive);
  } else if (b.reverse && (b.id === "accessory" || b.id === "accessoryR")) {
    // Orthodromic Kent: wait for the ventricular tip ray only — not every Purkinje twig
    const purk: SegmentId = b.id === "accessory" ? "purkinjeL" : "purkinjeR";
    const tipCi = KENT_PURK_CURVE[b.id];
    const h = parentHandoffTime(purk, branches, lesions, seen, b, tipCi);
    if (h != null) t0 = Math.max(t0, h);
  } else {
    const parents = b.reverse ? retroParentsFor(b.id) : anteParentsFor(b.id, ci, lesions);
    if (parents && parents.length) {
      const times: number[] = [];
      for (const pid of parents) {
        // Retrograde fascicle/bundle: prefer the tip Purkinje curve used by Kent
        let preferCurve: number | undefined;
        if (b.reverse && pid === "purkinjeL") preferCurve = KENT_PURK_CURVE.accessory;
        if (b.reverse && pid === "purkinjeR") preferCurve = KENT_PURK_CURVE.accessoryR;
        const h = parentHandoffTime(pid, branches, lesions, seen, b, preferCurve);
        if (h != null) times.push(h);
      }
      if (times.length) {
        // Retro multi-parent → first distal source (OR). Ante Purkinje with both
        // fascicles listed → wait for both (AND). Otherwise single-parent / OR.
        const handoff =
          b.reverse
            ? Math.min(...times)
            : parents.length > 1 && b.id === "purkinjeL"
              ? Math.max(...times)
              : times.length === 1
                ? times[0]!
                : Math.min(...times);
        t0 = Math.max(t0, handoff);
      }
    }
  }

  let t1: number;
  if (compactLoop) {
    // Keep author schedule end so His→Purkinje→Kent still fits one cycle
    t1 = Math.max(b.t1, t0 + 0.045);
    if (t0 >= b.t1 - 0.02) {
      t0 = Math.max(b.t0, b.t1 - Math.min(rawSpan, 0.08));
      t1 = Math.min(0.98, Math.max(b.t1, t0 + 0.045));
    }
  } else {
    // NSR / BBB: preserve travel duration when handoff delays the start
    t1 = Math.max(b.t1, t0 + rawSpan);
    t1 = Math.min(t1, t0 + rawSpan * 1.35);
    t1 = Math.max(t1, t0 + 0.04);
  }
  if (t1 > 0.995) {
    t1 = 0.995;
    t0 = Math.min(t0, t1 - 0.04);
  }
  const result = { t0, t1 };
  if (topLevel) {
    let branchCache = EFFECTIVE_WINDOW_CACHE.get(branches);
    if (!branchCache) {
      branchCache = new WeakMap();
      EFFECTIVE_WINDOW_CACHE.set(branches, branchCache);
    }
    let windows = branchCache.get(b);
    if (!windows) {
      windows = new Map();
      branchCache.set(b, windows);
    }
    windows.set(cacheKey, result);
  }
  return result;
}

function ventCascade(q: number, opts?: { lDelay?: number; rDelay?: number }): BranchWindow[] {
  const l = opts?.lDelay ?? 0;
  const r = opts?.rDelay ?? 0;
  // Compact cascade so HPS + myocardial seeds finish inside a normal QRS (~0.12–0.18)
  return [
    { id: "av", t0: q - 0.04, t1: q - 0.01, group: "av-delay" },
    { id: "his", t0: q - 0.01, t1: q + 0.025, group: "his" },
    { id: "rbb", t0: q + 0.02 + r, t1: q + 0.08 + r, group: "bundles" },
    { id: "lbb", t0: q + 0.02 + l, t1: q + 0.07 + l, group: "bundles" },
    { id: "lbba", t0: q + 0.045 + l, t1: q + 0.1 + l, group: "fascicles" },
    { id: "lbbp", t0: q + 0.045 + l, t1: q + 0.1 + l, group: "fascicles" },
    { id: "purkinjeR", t0: q + 0.06 + r, t1: q + 0.14 + r, group: "purkinje" },
    { id: "purkinjeL", t0: q + 0.06 + l, t1: q + 0.15 + l, group: "purkinje" },
  ];
}

/**
 * Vent cascade on a long multi-beat strip: keep absolute HPS durations (~NSR paper time)
 * instead of treating NSR cycle-fractions as fractions of a 2–3 s pattern window.
 */
function ventCascadePaper(qFrac: number, cycleSec: number, opts?: { lDelay?: number; rDelay?: number }): BranchWindow[] {
  const s = 0.86 / Math.max(0.4, cycleSec);
  const l = (opts?.lDelay ?? 0) * s;
  const r = (opts?.rDelay ?? 0) * s;
  return [
    { id: "av", t0: qFrac - 0.04 * s, t1: qFrac - 0.01 * s, group: "av-delay" },
    { id: "his", t0: qFrac - 0.01 * s, t1: qFrac + 0.025 * s, group: "his" },
    { id: "rbb", t0: qFrac + 0.02 * s + r, t1: qFrac + 0.08 * s + r, group: "bundles" },
    { id: "lbb", t0: qFrac + 0.02 * s + l, t1: qFrac + 0.07 * s + l, group: "bundles" },
    { id: "lbba", t0: qFrac + 0.045 * s + l, t1: qFrac + 0.1 * s + l, group: "fascicles" },
    { id: "lbbp", t0: qFrac + 0.045 * s + l, t1: qFrac + 0.1 * s + l, group: "fascicles" },
    { id: "purkinjeR", t0: qFrac + 0.06 * s + r, t1: qFrac + 0.14 * s + r, group: "purkinje" },
    { id: "purkinjeL", t0: qFrac + 0.06 * s + l, t1: qFrac + 0.15 * s + l, group: "purkinje" },
  ];
}

/** His → bundles → Purkinje without AV (junctional / His escape) */
function hpsCascade(q: number, opts?: { lDelay?: number; rDelay?: number }): BranchWindow[] {
  const l = opts?.lDelay ?? 0;
  const r = opts?.rDelay ?? 0;
  return [
    { id: "his", t0: q - 0.02, t1: q + 0.025, group: "ectopy" },
    { id: "rbb", t0: q + r, t1: q + 0.07 + r, group: "bundles" },
    { id: "lbb", t0: q + l, t1: q + 0.06 + l, group: "bundles" },
    { id: "lbba", t0: q + 0.02 + l, t1: q + 0.12 + l, group: "fascicles" },
    { id: "lbbp", t0: q + 0.02 + l, t1: q + 0.12 + l, group: "fascicles" },
    { id: "purkinjeR", t0: q + 0.03 + r, t1: q + 0.14 + r, group: "purkinje" },
    { id: "purkinjeL", t0: q + 0.03 + l, t1: q + 0.14 + l, group: "purkinje" },
  ];
}

function atrialAt(p: number): BranchWindow[] {
  return [
    { id: "sa", t0: p, t1: p + 0.05, group: "pacemaker" },
    { id: "internodal", t0: p + 0.015, t1: p + 0.09, group: "atrial" },
  ];
}

/**
 * PVC teaching schedule: clear myocardial-only gap after QRS onset, then
 * nearest Purkinje → reverse into bundle → contralateral tracts.
 * `side` = chamber of the wall focus.
 * Pass `schedule` so pathway windows match the EKG strip pattern.
 */
export function pvcBranches(
  side: "left" | "right",
  schedule?: { cycleSec: number; sinusP: number[]; pvcEvents: { q: number }[] },
): BranchWindow[] {
  const nearPurk: SegmentId = side === "left" ? "purkinjeL" : "purkinjeR";
  const nearBundle: SegmentId = side === "left" ? "lbb" : "rbb";
  const farPurk: SegmentId = side === "left" ? "purkinjeR" : "purkinjeL";
  const farBundle: SegmentId = side === "left" ? "rbb" : "lbb";
  const cycle = schedule?.cycleSec ?? 7;
  const sinusP = schedule?.sinusP ?? [0.14, 1.0, 2.72, 3.62, 5.4];
  const pvcQ = schedule?.pvcEvents?.map((e) => e.q) ?? [1.72, 4.62];
  const abs = (sec: number) => sec / cycle;
  const out: BranchWindow[] = [];

  for (const pSec of sinusP) {
    const p = abs(pSec);
    out.push(
      { id: "sa", t0: p, t1: p + abs(0.05), group: "pacemaker" },
      { id: "internodal", t0: p + abs(0.015), t1: p + abs(0.09), group: "atrial" },
    );
    const q = p + abs(0.16);
    out.push(
      { id: "av", t0: q - abs(0.05), t1: q - abs(0.015), group: "av-delay" },
      { id: "his", t0: q - abs(0.015), t1: q + abs(0.025), group: "his" },
      { id: "rbb", t0: q, t1: q + abs(0.07), group: "bundles" },
      { id: "lbb", t0: q, t1: q + abs(0.06), group: "bundles" },
      { id: "lbba", t0: q + abs(0.02), t1: q + abs(0.12), group: "fascicles" },
      { id: "lbbp", t0: q + abs(0.02), t1: q + abs(0.12), group: "fascicles" },
      { id: "purkinjeR", t0: q + abs(0.03), t1: q + abs(0.14), group: "purkinje" },
      { id: "purkinjeL", t0: q + abs(0.03), t1: q + abs(0.14), group: "purkinje" },
    );
  }
  for (const qSec of pvcQ) {
    const q = abs(qSec);
    // Brief myocardial-only gap, then Purkinje engage — times in absolute seconds
    const engage = q + abs(0.055);
    out.push(
      { id: nearPurk, t0: engage, t1: engage + abs(0.1), group: "ectopy" },
      { id: nearBundle, t0: engage + abs(0.02), t1: engage + abs(0.09), group: "ectopy", reverse: true },
      { id: farPurk, t0: engage + abs(0.05), t1: engage + abs(0.12), group: "ectopy" },
      {
        id: farBundle,
        t0: engage + abs(0.06),
        t1: engage + abs(0.11),
        group: "ectopy",
        reverse: true,
        u0: 0.45,
      },
    );
  }
  return out;
}

/** Site-aware PVC pathway windows (wall focus → nearest Purkinje). */
export function branchesForPvcSite(
  chamber: "leftVent" | "rightVent",
  schedule?: { cycleSec: number; sinusP: number[]; pvcEvents: { q: number }[] },
): BranchWindow[] {
  return pvcBranches(chamber === "leftVent" ? "left" : "right", schedule);
}

/**
 * CTI flutter ring curveIndex order (see conductionAnatomy PATHS):
 * 0 CTI (lateral→medial) · 1 septal ascending · 2 RA roof · 3 crista descending
 * Typical CCW: 0 → 1 → 2 → 3 → 0 (no reverse)
 * CW reverse: 3rev → 2rev → 1rev → 0rev
 *   = ↑crista → roof medial → ↓septum → CTI med→lat
 *
 * Timing must match sampleAflutter: cycle 0.8 s, F–F 0.20 s (4 F / window),
 * 2:1 QRS at 0.16 s and 0.56 s.
 */
const FLUTTER_RING_CCW = [0, 1, 2, 3] as const;
const FLUTTER_RING_CW = [3, 2, 1, 0] as const;
const FLUTTER_CYCLE_SEC = 0.8;
const FLUTTER_F_SEC = 0.2;
const FLUTTER_F0_SEC = 0.04;
const FLUTTER_QRS_SEC = [0.16, 0.56] as const;

function flutterCircuitBranches(dir: "ccw" | "cw"): BranchWindow[] {
  const lap = FLUTTER_F_SEC / FLUTTER_CYCLE_SEC;
  const f0 = FLUTTER_F0_SEC / FLUTTER_CYCLE_SEC;
  const nLaps = Math.round(FLUTTER_CYCLE_SEC / FLUTTER_F_SEC); // 4
  const ring = dir === "ccw" ? FLUTTER_RING_CCW : FLUTTER_RING_CW;
  const reverse = dir === "cw";
  const out: BranchWindow[] = [];

  for (let lapI = 0; lapI < nLaps; lapI++) {
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

  // 2:1 AV conduction — same absolute times as the EKG QRS marks
  for (const qSec of FLUTTER_QRS_SEC) {
    out.push(...ventCascade(qSec / FLUTTER_CYCLE_SEC));
  }

  return out;
}

/** Chaotic multi-wavelet atrial activation (AFib) — no SA pacemaker activity */
function afibBranches(): BranchWindow[] {
  const out: BranchWindow[] = [];
  // Overlapping wavelets on atrial pathways (never "sa"). Long, staggered windows so
  // pathway arrows and field shells glide continuously instead of blinking.
  const seeds = [
    { ci: 0, t0: 0.0, dur: 0.4 },
    { ci: 1, t0: 0.08, dur: 0.4 },
    { ci: 2, t0: 0.16, dur: 0.42 },
    { ci: 3, t0: 0.24, dur: 0.4 },
    { ci: 4, t0: 0.32, dur: 0.4 },
    { ci: 0, t0: 0.38, dur: 0.4 },
    { ci: 1, t0: 0.46, dur: 0.4 },
    { ci: 2, t0: 0.54, dur: 0.42 },
    { ci: 3, t0: 0.62, dur: 0.4 },
    { ci: 4, t0: 0.7, dur: 0.4 },
    { ci: 0, t0: 0.76, dur: 0.38 },
    { ci: 1, t0: 0.84, dur: 0.36 },
    { ci: 2, t0: 0.9, dur: 0.34 },
  ];
  for (const s of seeds) {
    const t1 = s.t0 + s.dur;
    out.push({
      id: "internodal",
      curveIndex: s.ci,
      t0: s.t0,
      t1: Math.min(1, t1),
      group: "atrial",
    });
    if (t1 > 1) {
      out.push({
        id: "internodal",
        curveIndex: s.ci,
        t0: 0,
        t1: t1 - 1,
        group: "atrial",
      });
    }
  }
  for (const q of [0.18, 0.72, 1.15, 1.95, 2.7].map((sec) => sec / 3.33)) {
    // Paper-scaled HPS so each irregular QRS gets a real cascade (not 0.14 of a 3.3 s loop)
    out.push(...ventCascadePaper(q, 3.33));
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
      t0: p + 0.02 * (0.86 / CYCLE),
      t1: qrs ?? p + 0.05 * (0.86 / CYCLE),
      group: "av-delay",
    });
    if (qrs != null) out.push(...ventCascadePaper(qrs, CYCLE));
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
  const s = 0.86 / CYCLE;
  for (const e of abs) {
    const p = e.p / CYCLE;
    const qrs = e.qrs == null ? null : e.qrs / CYCLE;
    out.push(...atrialAt(p));
    if (qrs != null) {
      out.push({ id: "av", t0: p + 0.015 * s, t1: qrs - 0.01 * s, group: "av-delay" });
      out.push(...ventCascadePaper(qrs, CYCLE));
    } else {
      out.push({ id: "av", t0: p + 0.015 * s, t1: p + 0.05 * s, group: "av-delay" });
      out.push({ id: "his", t0: p + 0.04 * s, t1: p + 0.07 * s, group: "his" });
    }
  }
  return out;
}

/** Fixed-ratio 2:1 — must match sampleAv21 (CYCLE 1.6 s) */
function av21Branches(): BranchWindow[] {
  const CYCLE = 1.6;
  const abs: { p: number; qrs: number | null }[] = [
    { p: 0.08, qrs: 0.08 + 0.18 },
    { p: 0.88, qrs: null },
  ];
  const out: BranchWindow[] = [];
  const s = 0.86 / CYCLE;
  for (const e of abs) {
    const p = e.p / CYCLE;
    const qrs = e.qrs == null ? null : e.qrs / CYCLE;
    out.push(...atrialAt(p));
    out.push({
      id: "av",
      t0: p + 0.02 * s,
      t1: qrs ?? p + 0.05 * s,
      group: "av-delay",
    });
    if (qrs != null) out.push(...ventCascadePaper(qrs, CYCLE));
  }
  return out;
}

/** High-grade 3:1 — must match sampleAv31 (CYCLE 2.4 s) */
function av31Branches(): BranchWindow[] {
  const CYCLE = 2.4;
  const abs: { p: number; qrs: number | null }[] = [
    { p: 0.08, qrs: 0.08 + 0.18 },
    { p: 0.88, qrs: null },
    { p: 1.68, qrs: null },
  ];
  const out: BranchWindow[] = [];
  const s = 0.86 / CYCLE;
  for (const e of abs) {
    const p = e.p / CYCLE;
    const qrs = e.qrs == null ? null : e.qrs / CYCLE;
    out.push(...atrialAt(p));
    out.push({
      id: "av",
      t0: p + 0.02 * s,
      t1: qrs ?? p + 0.05 * s,
      group: "av-delay",
    });
    if (qrs != null) out.push(...ventCascadePaper(qrs, CYCLE));
  }
  return out;
}

function atrialHisBase(): BranchWindow[] {
  return [
    { id: "sa", t0: 0.05, t1: 0.1, group: "pacemaker" },
    { id: "internodal", t0: 0.08, t1: 0.17, group: "atrial" },
    { id: "av", t0: 0.16, t1: 0.26, group: "av-delay" },
    { id: "his", t0: 0.26, t1: 0.32, group: "his" },
  ];
}

/** Pathway schedule for a custom / preset His–Purkinje lesion set */
export function branchesFromBundleBlocks(blocks: Iterable<BundleBlockId>): BranchWindow[] {
  const pattern = classifyBundleBlocks(blocks);

  if (pattern === "nsr") {
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.3, t1: 0.38, group: "bundles" },
      { id: "lbb", t0: 0.3, t1: 0.37, group: "bundles" },
      { id: "lbba", t0: 0.33, t1: 0.4, group: "fascicles" },
      { id: "lbbp", t0: 0.33, t1: 0.41, group: "fascicles" },
      { id: "purkinjeR", t0: 0.35, t1: 0.44, group: "purkinje" },
      { id: "purkinjeL", t0: 0.35, t1: 0.45, group: "purkinje" },
    ];
  }

  if (pattern === "trifascicular") {
    // Match sampleAv3 absolute timing (CYCLE 3.33 s): dissociated atria + wide ventricular escape
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

  if (pattern === "lbbb") {
    // Intact RBB / right Purkinje only — LV fills by myocardial spread (no left HPS ball)
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.3, t1: 0.4, group: "bundles" },
      { id: "purkinjeR", t0: 0.34, t1: 0.46, group: "purkinje" },
    ];
  }

  if (pattern === "rbbb") {
    // Intact left HPS only — RV fills by myocardial spread (no right HPS ball)
    return [
      ...atrialHisBase(),
      { id: "lbb", t0: 0.3, t1: 0.38, group: "bundles" },
      { id: "lbba", t0: 0.32, t1: 0.42, group: "fascicles" },
      { id: "lbbp", t0: 0.32, t1: 0.42, group: "fascicles" },
      { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje" },
    ];
  }

  if (pattern === "lafb") {
    // LAF silent — LPF + RBB conduct; anterior LV via myocardium from intact seeds
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.31, t1: 0.4, group: "bundles" },
      { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
      { id: "lbbp", t0: 0.33, t1: 0.42, group: "fascicles" },
      { id: "purkinjeR", t0: 0.36, t1: 0.46, group: "purkinje" },
      // Main LV Purkinje only (LPF curves 3–6); anterior LAF rays stay dark
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje", curveIndex: 3 },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje", curveIndex: 4 },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje", curveIndex: 5 },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje", curveIndex: 6 },
      { id: "purkinjeL", t0: 0.35, t1: 0.44, group: "purkinje", curveIndex: 7 },
    ];
  }

  if (pattern === "lpfb") {
    // LPF silent — LAF + RBB conduct; posterior LV via myocardium
    return [
      ...atrialHisBase(),
      { id: "rbb", t0: 0.31, t1: 0.4, group: "bundles" },
      { id: "lbb", t0: 0.31, t1: 0.36, group: "bundles" },
      { id: "lbba", t0: 0.33, t1: 0.42, group: "fascicles" },
      { id: "purkinjeR", t0: 0.36, t1: 0.46, group: "purkinje" },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje", curveIndex: 0 },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje", curveIndex: 1 },
      { id: "purkinjeL", t0: 0.35, t1: 0.46, group: "purkinje", curveIndex: 2 },
      { id: "purkinjeL", t0: 0.35, t1: 0.44, group: "purkinje", curveIndex: 7 },
    ];
  }

  if (pattern === "rbbbLafb") {
    // Only LPF conducts; RBB + LAF silent
    return [
      ...atrialHisBase(),
      { id: "lbb", t0: 0.3, t1: 0.36, group: "bundles" },
      { id: "lbbp", t0: 0.32, t1: 0.42, group: "fascicles" },
      { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje", curveIndex: 3 },
      { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje", curveIndex: 4 },
      { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje", curveIndex: 5 },
      { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje", curveIndex: 6 },
      { id: "purkinjeL", t0: 0.34, t1: 0.44, group: "purkinje", curveIndex: 7 },
    ];
  }

  // rbbbLpfb — only LAF conducts; RBB + LPF silent
  return [
    ...atrialHisBase(),
    { id: "lbb", t0: 0.3, t1: 0.36, group: "bundles" },
    { id: "lbba", t0: 0.32, t1: 0.42, group: "fascicles" },
    { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje", curveIndex: 0 },
    { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje", curveIndex: 1 },
    { id: "purkinjeL", t0: 0.34, t1: 0.46, group: "purkinje", curveIndex: 2 },
    { id: "purkinjeL", t0: 0.34, t1: 0.44, group: "purkinje", curveIndex: 7 },
  ];
}

const BRANCH_CACHE = new Map<string, BranchWindow[]>();

export function branchesForFinding(finding: FindingId | string | undefined): BranchWindow[] {
  const key = finding ?? "nsr";
  const hit = BRANCH_CACHE.get(key);
  if (hit) return hit;

  let result: BranchWindow[];
  if (finding === "aflutterCcw") result = flutterCircuitBranches("ccw");
  else if (finding === "aflutterCw") result = flutterCircuitBranches("cw");
  else if (finding === "afib") result = afibBranches();
  else {
    result = buildBranchesForFinding(finding);
  }
  BRANCH_CACHE.set(key, result);
  return result;
}

function buildBranchesForFinding(finding: FindingId | string | undefined): BranchWindow[] {
  const base = NSR_BRANCHES.map((b) => ({ ...b }));

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

  if (finding === "avnrtTypical" || finding === "avnrt") {
    // Typical slow–fast: anterograde slow → His–Purkinje; retrograde fast → atria
    // Overlap limbs so the field never goes dark at dual-pathway handoffs.
    return [
      { id: "avnrtSlow", t0: 0.0, t1: 0.2, group: "avnrt" },
      { id: "av", t0: 0.1, t1: 0.2, group: "av-delay" },
      { id: "his", t0: 0.14, t1: 0.24, group: "his" },
      { id: "rbb", t0: 0.18, t1: 0.32, group: "bundles" },
      { id: "lbb", t0: 0.18, t1: 0.3, group: "bundles" },
      { id: "lbba", t0: 0.2, t1: 0.32, group: "fascicles" },
      { id: "lbbp", t0: 0.2, t1: 0.32, group: "fascicles" },
      { id: "purkinjeR", t0: 0.22, t1: 0.36, group: "purkinje" },
      { id: "purkinjeL", t0: 0.22, t1: 0.36, group: "purkinje" },
      { id: "avnrtFast", t0: 0.16, t1: 0.38, group: "avnrt", reverse: true },
      { id: "internodal", t0: 0.26, t1: 0.48, group: "atrial", reverse: true },
      { id: "sa", t0: 0.34, t1: 0.5, group: "pacemaker", reverse: true },
    ];
  }

  if (finding === "avnrtAtypical") {
    // Fast–slow: anterograde fast → His–Purkinje; retrograde slow → atria (long RP)
    return [
      { id: "avnrtFast", t0: 0.0, t1: 0.16, group: "avnrt" },
      { id: "av", t0: 0.08, t1: 0.18, group: "av-delay" },
      { id: "his", t0: 0.12, t1: 0.22, group: "his" },
      { id: "rbb", t0: 0.16, t1: 0.3, group: "bundles" },
      { id: "lbb", t0: 0.16, t1: 0.28, group: "bundles" },
      { id: "lbba", t0: 0.18, t1: 0.3, group: "fascicles" },
      { id: "lbbp", t0: 0.18, t1: 0.3, group: "fascicles" },
      { id: "purkinjeR", t0: 0.2, t1: 0.34, group: "purkinje" },
      { id: "purkinjeL", t0: 0.2, t1: 0.34, group: "purkinje" },
      { id: "avnrtSlow", t0: 0.24, t1: 0.58, group: "avnrt", reverse: true },
      { id: "internodal", t0: 0.4, t1: 0.68, group: "atrial", reverse: true },
      { id: "sa", t0: 0.5, t1: 0.7, group: "pacemaker", reverse: true },
    ];
  }

  if (finding === "avrtOrthoLeft" || finding === "avrtOrthoRight") {
    const left = finding === "avrtOrthoLeft";
    const ap: SegmentId = left ? "accessory" : "accessoryR";
    const purk: SegmentId = left ? "purkinjeL" : "purkinjeR";
    const purkCi = left ? 2 : 0; // LV anterolateral · base / RV free-wall · superior
    // Orthodromic: AV → His → bundles → fascicles → Purkinje tip → up Kent → AV
    return [
      { id: "av", t0: 0.0, t1: 0.14, group: "av-delay" },
      { id: "his", t0: 0.08, t1: 0.22, group: "his" },
      { id: "rbb", t0: 0.14, t1: 0.34, group: "bundles" },
      { id: "lbb", t0: 0.14, t1: 0.34, group: "bundles" },
      { id: "lbba", t0: 0.18, t1: 0.4, group: "fascicles" },
      { id: "lbbp", t0: 0.18, t1: 0.38, group: "fascicles" },
      { id: "purkinjeR", t0: 0.24, t1: 0.48, group: "purkinje" },
      { id: "purkinjeL", t0: 0.24, t1: 0.5, group: "purkinje" },
      { id: purk, t0: 0.38, t1: 0.55, group: "purkinje", curveIndex: purkCi },
      { id: ap, t0: 0.42, t1: 0.82, group: "accessory", reverse: true },
      { id: "av", t0: 0.74, t1: 0.95, group: "av-delay" },
    ];
  }

  if (finding === "avrtAntiLeft" || finding === "avrtAntiRight") {
    const left = finding === "avrtAntiLeft";
    const ap: SegmentId = left ? "accessory" : "accessoryR";
    const purk: SegmentId = left ? "purkinjeL" : "purkinjeR";
    const fasc: SegmentId = left ? "lbba" : "rbb";
    const bundle: SegmentId = left ? "lbb" : "rbb";
    const purkCi = left ? 2 : 0; // LV anterolateral · base / RV free-wall · superior
    // Antidromic: down Kent → Purkinje tip · reverse up to His → AV → atrial Kent
    return [
      { id: ap, t0: 0.0, t1: 0.3, group: "accessory", u0: 0.4 },
      // Reverse along the tip curve (tip → fascicle / moderator band)
      { id: purk, t0: 0.12, t1: 0.42, group: "purkinje", reverse: true, curveIndex: purkCi },
      { id: fasc, t0: 0.28, t1: 0.52, group: "fascicles", reverse: true },
      { id: bundle, t0: 0.4, t1: 0.6, group: "bundles", reverse: true },
      { id: "his", t0: 0.5, t1: 0.7, group: "his", reverse: true },
      { id: "av", t0: 0.6, t1: 0.78, group: "av-delay", reverse: true },
      { id: ap, t0: 0.7, t1: 0.92, group: "accessory", u0: 0, u1: 0.42 },
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
    // Spike @ 0.22 — myocardial wall capture first, then Purkinje/bundle engagement
    return [
      { id: "purkinjeR", t0: 0.3, t1: 0.48, group: "ectopy" },
      { id: "rbb", t0: 0.32, t1: 0.46, group: "ectopy", reverse: true },
      { id: "purkinjeL", t0: 0.38, t1: 0.54, group: "ectopy" },
      { id: "lbb", t0: 0.4, t1: 0.52, group: "ectopy", reverse: true, u0: 0.4 },
    ];
  }
  if (finding === "pacedDual") {
    // A spike 0.08 · V spike 0.28 — RA wall field fills atria through AV delay
    return [
      { id: "internodal", t0: 0.08, t1: 0.28, group: "atrial" },
      { id: "av", t0: 0.18, t1: 0.28, group: "av-delay" },
      { id: "purkinjeR", t0: 0.36, t1: 0.54, group: "ectopy" },
      { id: "rbb", t0: 0.38, t1: 0.5, group: "ectopy", reverse: true },
      { id: "purkinjeL", t0: 0.42, t1: 0.56, group: "ectopy" },
    ];
  }
  if (finding === "pacedRvSeptal") {
    // Mid-septal myocardial capture — earlier left engagement than apical
    return [
      { id: "internodal", t0: 0.08, t1: 0.27, group: "atrial" },
      { id: "av", t0: 0.18, t1: 0.27, group: "av-delay" },
      { id: "purkinjeR", t0: 0.34, t1: 0.5, group: "ectopy" },
      { id: "rbb", t0: 0.35, t1: 0.48, group: "ectopy", reverse: true, u0: 0.35 },
      { id: "purkinjeL", t0: 0.38, t1: 0.52, group: "ectopy" },
      { id: "lbb", t0: 0.4, t1: 0.52, group: "ectopy", reverse: true, u0: 0.45 },
    ];
  }
  if (finding === "pacedRvot") {
    // RVOT myocardial capture — superior exit, late apical/left
    return [
      { id: "internodal", t0: 0.08, t1: 0.27, group: "atrial" },
      { id: "av", t0: 0.18, t1: 0.27, group: "av-delay" },
      { id: "rbb", t0: 0.34, t1: 0.48, group: "ectopy", reverse: true, u0: 0.15 },
      { id: "purkinjeR", t0: 0.36, t1: 0.52, group: "ectopy" },
      { id: "purkinjeL", t0: 0.42, t1: 0.58, group: "ectopy" },
      { id: "lbb", t0: 0.44, t1: 0.56, group: "ectopy", reverse: true, u0: 0.5 },
    ];
  }
  if (finding === "pacedHis") {
    // His conduction capture → both bundles nearly physiologic
    return [
      { id: "internodal", t0: 0.08, t1: 0.26, group: "atrial" },
      { id: "av", t0: 0.18, t1: 0.26, group: "av-delay" },
      { id: "his", t0: 0.26, t1: 0.36, group: "his" },
      { id: "rbb", t0: 0.32, t1: 0.46, group: "bundles" },
      { id: "lbb", t0: 0.32, t1: 0.46, group: "bundles" },
      { id: "lbba", t0: 0.34, t1: 0.48, group: "fascicles" },
      { id: "lbbp", t0: 0.34, t1: 0.48, group: "fascicles" },
      { id: "purkinjeR", t0: 0.36, t1: 0.5, group: "purkinje" },
      { id: "purkinjeL", t0: 0.36, t1: 0.5, group: "purkinje" },
    ];
  }
  if (finding === "pacedLbap") {
    // LBAP tip fires conduction tissue, then engages left bundle
    return [
      { id: "internodal", t0: 0.08, t1: 0.26, group: "atrial" },
      { id: "av", t0: 0.18, t1: 0.26, group: "av-delay" },
      { id: "lbb", t0: 0.32, t1: 0.46, group: "ectopy", u0: 0.35 },
      { id: "lbba", t0: 0.34, t1: 0.48, group: "fascicles" },
      { id: "lbbp", t0: 0.34, t1: 0.48, group: "fascicles" },
      { id: "purkinjeL", t0: 0.36, t1: 0.5, group: "purkinje" },
      { id: "his", t0: 0.34, t1: 0.42, group: "his", reverse: true },
      { id: "rbb", t0: 0.38, t1: 0.5, group: "bundles" },
      { id: "purkinjeR", t0: 0.4, t1: 0.52, group: "purkinje" },
    ];
  }
  if (finding === "pacedBiv") {
    // BiV spike @ 0.27 — RV + LV wall fields fuse, then tracts
    return [
      { id: "internodal", t0: 0.08, t1: 0.27, group: "atrial" },
      { id: "av", t0: 0.18, t1: 0.27, group: "av-delay" },
      { id: "purkinjeR", t0: 0.34, t1: 0.52, group: "ectopy" },
      { id: "purkinjeL", t0: 0.34, t1: 0.52, group: "ectopy" },
      { id: "rbb", t0: 0.36, t1: 0.48, group: "ectopy", reverse: true },
      { id: "lbb", t0: 0.36, t1: 0.48, group: "ectopy", reverse: true },
    ];
  }
  if (finding === "pacedAtrial") {
    // RA appendage wall capture → AV → His–Purkinje (narrow QRS)
    return [
      { id: "internodal", t0: 0.08, t1: 0.28, group: "atrial" },
      { id: "av", t0: 0.2, t1: 0.3, group: "av-delay" },
      { id: "his", t0: 0.28, t1: 0.36, group: "his" },
      { id: "rbb", t0: 0.32, t1: 0.46, group: "bundles" },
      { id: "lbb", t0: 0.32, t1: 0.46, group: "bundles" },
      { id: "lbba", t0: 0.34, t1: 0.48, group: "fascicles" },
      { id: "lbbp", t0: 0.34, t1: 0.48, group: "fascicles" },
      { id: "purkinjeR", t0: 0.36, t1: 0.5, group: "purkinje" },
      { id: "purkinjeL", t0: 0.36, t1: 0.5, group: "purkinje" },
    ];
  }
  if (finding === "av1") {
    // Match sampleNsr(prDelay=0.2): QRS / HPS delayed by +0.20 cycle
    const d = 0.2;
    for (const b of base) {
      if (b.id === "av") b.t1 += d;
      if (b.group === "his" || b.group === "bundles" || b.group === "fascicles" || b.group === "purkinje") {
        b.t0 += d;
        b.t1 += d;
      }
    }
  }
  if (finding === "ivcd") {
    // Mildly prolonged HPS transit — wide QRS without discrete BBB lesion
    for (const b of base) {
      if (b.group === "bundles" || b.group === "fascicles" || b.group === "purkinje") {
        b.t1 += 0.06;
      }
    }
  }
  if (finding === "av2i") return av2iBranches();
  if (finding === "av2ii") return av2iiBranches();
  if (finding === "av21") return av21Branches();
  if (finding === "av31") return av31Branches();
  if (finding === "av3Junctional") {
    // Supra-His complete block · narrow junctional / His escape (CYCLE 2.67 s)
    const CYCLE = 2.67;
    const atr = [0.1, 0.77, 1.43, 2.1].map((s) => s / CYCLE);
    const esc = [0.45, 1.78].map((s) => s / CYCLE);
    const out: BranchWindow[] = [];
    for (const p of atr) out.push(...atrialAt(p));
    for (const q of esc) out.push(...hpsCascade(q));
    return out;
  }
  if (finding === "av3") {
    // Infra-His complete block · wide ventricular escape (CYCLE 3.33 s)
    const CYCLE = 3.33;
    const atr = [0.12, 0.78, 1.45, 2.11, 2.78].map((s) => s / CYCLE);
    const esc = [0.5, 2.17].map((s) => s / CYCLE);
    const out: BranchWindow[] = [];
    for (const p of atr) out.push(...atrialAt(p));
    // Ventricular escape is myocardial and centrifugal. Do not invent a
    // simultaneous bilateral Purkinje cascade; the focus owns each wide QRS.
    void esc;
    return out;
  }
  if (finding === "vfCoarse" || finding === "vfFine") return [];
  if (finding === "vt") {
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
  if (finding === "pac") {
    // Multi-beat strip (7 s): sinus + two PACs — atrial myocardium first, then AV cascade
    const CYCLE = 7;
    const abs = (sec: number) => sec / CYCLE;
    const beats: { kind: "sinus" | "pac"; p: number }[] = [
      { kind: "sinus", p: 0.14 },
      { kind: "sinus", p: 0.98 },
      { kind: "pac", p: 1.72 },
      { kind: "sinus", p: 2.55 },
      { kind: "sinus", p: 3.4 },
      { kind: "pac", p: 3.82 },
      { kind: "sinus", p: 4.7 },
      { kind: "sinus", p: 5.58 },
    ];
    const out: BranchWindow[] = [];
    for (const b of beats) {
      const p = abs(b.p);
      const pr = b.kind === "pac" ? 0.14 : 0.16;
      if (b.kind === "sinus") {
        out.push({ id: "sa", t0: p, t1: p + abs(0.05), group: "pacemaker" });
        out.push({ id: "internodal", t0: p + abs(0.015), t1: p + abs(0.1), group: "atrial" });
      } else {
        // PAC: myocardial atrial field first; internodal engages after the wall wave
        out.push({
          id: "internodal",
          t0: p + abs(0.05),
          t1: p + abs(0.14),
          group: "ectopy",
        });
      }
      const q = p + abs(pr);
      out.push(
        { id: "av", t0: q - abs(0.05), t1: q - abs(0.015), group: "av-delay" },
        { id: "his", t0: q - abs(0.015), t1: q + abs(0.025), group: "his" },
        { id: "rbb", t0: q, t1: q + abs(0.07), group: "bundles" },
        { id: "lbb", t0: q, t1: q + abs(0.06), group: "bundles" },
        { id: "lbba", t0: q + abs(0.02), t1: q + abs(0.12), group: "fascicles" },
        { id: "lbbp", t0: q + abs(0.02), t1: q + abs(0.12), group: "fascicles" },
        { id: "purkinjeR", t0: q + abs(0.03), t1: q + abs(0.14), group: "purkinje" },
        { id: "purkinjeL", t0: q + abs(0.03), t1: q + abs(0.14), group: "purkinje" },
      );
    }
    return out;
  }
  if (finding === "pvc") {
    // Myocardial wall field first; Purkinje/bundles engage after the front reaches them.
    // Site-specific nearest tract is applied in main via branchesForPvcSite when available.
    return pvcBranches("right");
  }
  if (finding === "failureToSense") {
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
  /** Index among parallel curves of this segment (e.g. LAF vs LPF Purkinje rays) */
  curveIndex?: number;
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
  /** True when this limb is traversed retrograde (u decreasing) */
  reverse?: boolean;
  /** Which parallel curve of this segment (stable arrow-slot key) */
  curveIndex?: number;
  /** True while holding at the distal tip after t1 (junction linger) */
  tipHold?: boolean;
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
      // Reentry atrial echo / Kent upstroke often sits on ST–T — keep those groups live
      return [
        "his",
        "bundles",
        "fascicles",
        "purkinje",
        "ectopy",
        "accessory",
        "transseptal",
        "avnrt",
        "atrial",
        "pacemaker",
        "av-delay",
      ];
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
      // Short — circuit reenters each F wave (~0.25 of the 0.8 s pattern)
      return 0.09;
    case "avnrtSlow":
    case "avnrtFast":
      // Long ERP so the unused limb stays inhibited into the next lap
      // (why the wave can only go one way around the dual-pathway loop).
      return 0.78;
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
    case "accessoryR":
      return 0.26;
    default:
      return 0.25;
  }
}

/** 1 = conducting now, (0,1) = refractory afterglow, 0 = recovered.
 *  Uses causal handoff windows so tubes don't light before the upstream ball arrives.
 */
export function refractoryGlow(
  tCycle: number,
  branches: BranchWindow[],
  id: SegmentId,
  curveIndex?: number,
  lesionIds?: Iterable<SegmentId>,
  cycleSec = 0.86,
): number {
  const t = ((tCycle % 1) + 1) % 1;
  let best = 0;

  for (const b of branchesBySegment(branches).get(id) ?? []) {
    if (b.curveIndex != null && curveIndex != null && b.curveIndex !== curveIndex) continue;

    const win = effectiveImpulseWindow(b, branches, lesionIds, curveIndex ?? b.curveIndex);
    if (!win) continue;

    if (t >= win.t0 && t <= win.t1) {
      best = Math.max(best, 1);
      continue;
    }

    // Refractory values were authored in an NSR-sized cycle. Preserve their
    // absolute paper duration on 3–7 second PAC/PVC/AF/CHB strips.
    const ref = refractoryFrac(b.id) * Math.min(1, 0.86 / Math.max(0.25, cycleSec));
    if (ref <= 0) continue;

    let since = -1;
    const refEnd = win.t1 + ref;
    if (refEnd <= 1) {
      if (t > win.t1 && t < refEnd) since = t - win.t1;
    } else if (t > win.t1) {
      since = t - win.t1;
    } else if (t < refEnd - 1) {
      since = 1 - win.t1 + t;
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
    case "av21":
    case "av31":
    case "av3Junctional":
      return "supra-his";
    case "av2ii":
    case "av3":
      return "infra-his";
    default:
      return "none";
  }
}
