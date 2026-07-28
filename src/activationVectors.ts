import * as THREE from "three";
import type { CycleMark, LeadId } from "./ekgWaveforms";
import type { FindingId, SegmentId } from "./findings";
import { inMyocardialShell, projectOntoMyocardialShell, projectOntoShellTangent, ellipsoidNormal, shellArcDistance } from "./heartEllipsoid";
import { fitCardiacVector } from "./leadAxes";
import type { ActiveFront, BranchWindow, PathwayProbePoint } from "./pathwayTiming";
import { branchesForFinding, groupsForMark } from "./pathwayTiming";

/** Expanding myocardial wavefront from a free focus (PVC / paced / VT). */
export type MyocardialFocusOpts = {
  pos: [number, number, number];
  color?: number;
  /** Cycle fraction when capture begins */
  t0?: number;
  /** Cycle fraction per shell-arc unit (smaller = faster spread) */
  speed?: number;
  /** How long the expanding wave stays active (cycle fraction) */
  waveDur?: number;
  /** Focus fire-pulse duration (cycle fraction) */
  fireDur?: number;
  /** Which shell the wave drives (pace RA → atrial, RV/LV → ventricular) */
  tissue?: "atrial" | "ventricular";
};

function normalizeFoci(
  focus: MyocardialFocusOpts | MyocardialFocusOpts[] | null | undefined,
): MyocardialFocusOpts[] {
  if (!focus) return [];
  return Array.isArray(focus) ? focus : [focus];
}

/** Kent-tip eccentric field during antidromic pre-excitation / delta. */
export type PreExcitationOpts = {
  pos: [number, number, number];
  color?: number;
  t0?: number;
  t1?: number;
};

export type VectorView = {
  root: THREE.Group;
  setMeanVisible: (v: boolean) => void;
  setFieldVisible: (v: boolean) => void;
  update: (opts: {
    mark: CycleMark;
    active: SegmentId[];
    finding: FindingId;
    tCycle: number;
    /** Optional lead voltages for magnitude coupling to the EKG */
    leads?: Partial<Record<LeadId, number>>;
    /** Stim / custom schedule — same windows as impulse animation */
    branches?: BranchWindow[];
    /** Per-branch impulse fronts with travel direction */
    fronts?: ActiveFront[];
    /** Field-first ectopic / paced myocardial focus (one or many pace leads) */
    ectopyFocus?: MyocardialFocusOpts | MyocardialFocusOpts[] | null;
    /** Antidromic AVRT pre-excitation myocardial field */
    preExcitation?: PreExcitationOpts | null;
    /** Lesioned tracts — suppress field along blocked pathways */
    lesionIds?: SegmentId[];
  }) => void;
};

type FieldSample = {
  pos: THREE.Vector3;
  tissue: "atrial" | "ventricular" | "insulator";
  nearestId: SegmentId;
  nearestColor: number;
  dir: THREE.Vector3;
  /** Smoothed display direction so arrows don't flicker between frames */
  dirSmooth: THREE.Vector3;
  /** Parametric position along nearest pathway (0–1) */
  pathU: number;
  /** Depolarization arrival time (NSR-baked; remapped live) */
  actTime: number;
  arrow: THREE.ArrowHelper;
  /** Soft residual so the field fades instead of blinking off */
  glow: number;
  /** 0 = pathway color, 1 = ectopy/focus color — smoothed handoff */
  pvcBlend: number;
};

function makeArrow(color: number, length: number): THREE.ArrowHelper {
  const arrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, 0),
    length,
    color,
    length * 0.28,
    length * 0.16,
  );
  arrow.line.material = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.9,
  });
  const coneMat = arrow.cone.material;
  if (coneMat instanceof THREE.MeshBasicMaterial) {
    coneMat.transparent = true;
    coneMat.opacity = 0.9;
  }
  return arrow;
}

/** Relative mass / teaching weight for impulse-front contributions to the resultant. */
function frontMass(id: SegmentId): number {
  switch (id) {
    case "sa":
      return 1.35;
    case "internodal":
    case "flutter":
      return 1.1;
    case "av":
    case "avnrtSlow":
    case "avnrtFast":
      return 1.0;
    case "his":
      return 0.95;
    case "rbb":
    case "lbb":
    case "lbba":
    case "lbbp":
      return 1.05;
    case "purkinjeR":
      return 1.15;
    case "purkinjeL":
      return 1.45;
    case "accessory":
    case "accessoryR":
      return 1.2;
    default:
      return 1;
  }
}

/**
 * Mean + field vectors driven by the same physiologic timeline as the EKG / impulse.
 * Main arrow tracks the activation (and recovery) front — not the ECG lead dipole.
 */
export function createActivationVectors(probes: PathwayProbePoint[]): VectorView {
  const root = new THREE.Group();
  root.name = "activationVectors";

  const meanGroup = new THREE.Group();
  meanGroup.name = "meanVectors";
  meanGroup.visible = false;

  const fieldGroup = new THREE.Group();
  fieldGroup.name = "vectorField";
  fieldGroup.visible = false;

  const meanArrow = makeArrow(0xf0c040, 2.2);
  meanGroup.add(meanArrow);

  /** One arrow per currently activating anatomic curve (matches impulse pulse fronts). */
  const BRANCH_ARROW_POOL = 96;
  const branchArrows: THREE.ArrowHelper[] = [];
  for (let i = 0; i < BRANCH_ARROW_POOL; i++) {
    const a = makeArrow(0x3db8c8, 0.4);
    a.visible = false;
    branchArrows.push(a);
    meanGroup.add(a);
  }
  /** Stable slot → pool index so fronts don't jump/blink when the list reshuffles */
  const branchSlotToPool = new Map<string, number>();
  const branchSlotOpacity = new Float32Array(BRANCH_ARROW_POOL);
  const branchPoolFree: number[] = [];
  for (let i = BRANCH_ARROW_POOL - 1; i >= 0; i--) branchPoolFree.push(i);

  const waveMat = new THREE.MeshBasicMaterial({
    color: 0x88f0c0,
    transparent: true,
    opacity: 0.3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const wavefront = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.5, 48), waveMat);
  meanGroup.add(wavefront);

  const insulator = new THREE.Mesh(
    new THREE.RingGeometry(0.15, 0.72, 48),
    new THREE.MeshBasicMaterial({
      color: 0xb0b8c0,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  insulator.rotation.x = Math.PI / 2;
  insulator.position.set(0.02, 0.04, -0.05);
  fieldGroup.add(insulator);

  const hisGap = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 12, 10),
    new THREE.MeshBasicMaterial({
      color: 0xff5e6c,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );
  hisGap.position.set(0.04, 0.02, -0.08);
  fieldGroup.add(hisGap);

  const FOCUS_POOL = 4;
  const focusMarkers: THREE.Mesh[] = [];
  const focusRings: THREE.Mesh[] = [];
  for (let i = 0; i < FOCUS_POOL; i++) {
    const focusMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 14, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff8844,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    focusMarker.visible = false;
    focusMarker.name = `myocardialFocus${i}`;
    fieldGroup.add(focusMarker);
    focusMarkers.push(focusMarker);

    const focusRing = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.11, 40),
      new THREE.MeshBasicMaterial({
        color: 0xff8844,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    focusRing.visible = false;
    fieldGroup.add(focusRing);
    focusRings.push(focusRing);
  }
  const focusRingQuat = new THREE.Quaternion();
  const focusRingZ = new THREE.Vector3(0, 0, 1);

  const probePos = probes.map((p) => new THREE.Vector3(...p.pos));
  const probeTan = probes.map((p) => new THREE.Vector3(...p.tangent).normalize());
  const samples: FieldSample[] = [];

  const branchMeta = new Map<SegmentId, { group: string; t0: number; t1: number }>();
  for (const b of branchesForFinding("nsr")) {
    const prev = branchMeta.get(b.id);
    if (!prev) branchMeta.set(b.id, { group: b.group, t0: b.t0, t1: b.t1 });
    else {
      branchMeta.set(b.id, {
        group: b.group,
        t0: Math.min(prev.t0, b.t0),
        t1: Math.max(prev.t1, b.t1),
      });
    }
  }

  function nearestProbe(pos: THREE.Vector3, tissue: "atrial" | "ventricular") {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < probes.length; i++) {
      const id = probes[i]!.segmentId;
      const atrialSeg =
        id === "sa" ||
        id === "internodal" ||
        id === "flutter" ||
        id === "av" ||
        id === "avnrtSlow" ||
        id === "avnrtFast" ||
        id === "accessory" ||
        id === "accessoryR";
      if (tissue === "atrial" && !atrialSeg && id !== "his") continue;
      if (tissue === "ventricular" && atrialSeg && id !== "accessory" && id !== "accessoryR") continue;
      const d = pos.distanceToSquared(probePos[i]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD === Infinity) {
      for (let i = 0; i < probes.length; i++) {
        const d = pos.distanceToSquared(probePos[i]!);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return { idx: best, dist: Math.sqrt(bestD) };
  }

  for (let ix = -5; ix <= 5; ix++) {
    for (let iy = -6; iy <= 5; iy++) {
      for (let iz = -4; iz <= 4; iz++) {
        const x = ix * 0.18;
        const y = iy * 0.17 - 0.15;
        const z = iz * 0.18;
        // Thick myocardial shell only — no arrows in the hollow cavity
        if (!inMyocardialShell([x, y, z])) continue;

        const inInsulator =
          Math.abs(y - 0.04) < 0.07 && Math.hypot(x - 0.04, z + 0.08) > 0.1;
        const tissue: FieldSample["tissue"] = inInsulator
          ? "insulator"
          : y > 0.08
            ? "atrial"
            : "ventricular";

        const pos = new THREE.Vector3(x, y, z);
        const arrow = makeArrow(0x3db8c8, 0.18);
        arrow.visible = false;
        fieldGroup.add(arrow);

        if (tissue === "insulator") {
          const idir = new THREE.Vector3(0, 1, 0);
          samples.push({
            pos,
            tissue,
            nearestId: "his",
            nearestColor: 0x9aa4ae,
            dir: idir,
            dirSmooth: idir.clone(),
            pathU: 0,
            actTime: 99,
            arrow,
            glow: 0,
            pvcBlend: 0,
          });
          continue;
        }

        const { idx, dist } = nearestProbe(pos, tissue);
        const pr = probes[idx]!;
        const tangent = probeTan[idx]!.clone();
        const outward = pos.clone().sub(probePos[idx]!);
        if (outward.lengthSq() > 1e-8) outward.normalize();
        else outward.set(0, 0, 0);
        const dir = tangent.clone().multiplyScalar(0.75).add(outward.multiplyScalar(0.25));
        if (dir.lengthSq() < 1e-6) dir.copy(tangent);
        else dir.normalize();
        // Keep travel along the wall (don't dive into the cavity)
        projectOntoShellTangent(dir, pos);

        const pathTime = pr.enterT + (pr.exitT - pr.enterT) * pr.pathU;
        const actTime = pathTime + dist * 0.42;

        samples.push({
          pos,
          tissue,
          nearestId: pr.segmentId,
          nearestColor: pr.color,
          dir,
          dirSmooth: dir.clone(),
          pathU: pr.pathU,
          actTime,
          arrow,
          glow: 0,
          pvcBlend: 0,
        });
      }
    }
  }

  root.add(meanGroup, fieldGroup);

  const tmpSum = new THREE.Vector3();
  const tmpOrigin = new THREE.Vector3();
  const tmpToFront = new THREE.Vector3();
  /** Smoothed resultant — direction/strength track the EKG dipole; origin tracks the front. */
  const smoothMeanDir = new THREE.Vector3(0.45, -0.72, 0.22).normalize();
  const smoothMeanOrigin = new THREE.Vector3(-0.52, 0.58, 0.22); // SA
  let smoothMeanStrength = 0;
  let smoothMeanReady = false;
  let smoothMeanColor = new THREE.Color(0xf0c040);
  let smoothWaveColor = new THREE.Color(0xf0c040);

/**
 * Instantaneous ECG dipole from the same lead voltages drawn on the strip.
 * leadAxes: +X left, +Y inferior, +Z anterior.
 * heart model: +X left, +Y superior, +Z anterior → negate Y.
 *
 * Mean QRS teaching axis is mostly frontal (~+40° left-inferior, mild anterior).
 * Precordial residuals (late S in V1–V2) are damped so they don't yank the
 * arrow strongly posterior through the R peak.
 */
function meanFromLeads(leads?: Partial<Record<LeadId, number>>): {
  dir: THREE.Vector3;
  strength: number;
} | null {
  if (!leads) return null;
  const v = fitCardiacVector(leads);
  const z = (v.z ?? 0) * 0.4;
  const model = new THREE.Vector3(v.x, -v.y, z);
  const m = model.length();
  if (m < 1e-5) return null;
  return {
    dir: model.multiplyScalar(1 / m),
    strength: Math.min(1.05, m * 0.72),
  };
}

function ekgMagnitude(leads?: Partial<Record<LeadId, number>>): number {
  if (!leads) return 1;
  const keys: LeadId[] = ["I", "II", "III", "V1", "V2", "V3", "V4", "V5", "V6"];
  let s = 0;
  let n = 0;
  for (const k of keys) {
    const v = leads[k];
    if (v == null) continue;
    s += v * v;
    n++;
  }
  if (!n) return 1;
  return Math.min(1.8, Math.max(0.15, Math.sqrt(s / n) * 1.4));
}

/**
 * Secondary T-wave changes: recovery vector opposite the QRS (discordant).
 * Normal myocardium: epi recovers first → ECG T stays roughly concordant with QRS.
 */
function isDiscordantRepol(finding: FindingId): boolean {
  switch (finding) {
    case "lbbb":
    case "rbbb":
    case "rbbbLafb":
    case "rbbbLpfb":
    case "pac":
    case "pvc":
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
    case "vtPoly":
    case "torsades":
    case "vfCoarse":
    case "vfFine":
    case "pacedVentricular":
    case "pacedDual":
    case "pacedBiv":
    case "av3":
    case "avrtAntiLeft":
    case "avrtAntiRight":
    case "sgarbossa":
      return true;
    default:
      return false;
  }
}

/** ECG-effective recovery polarity vs local depolarization direction */
function repolFlipsDepol(finding: FindingId, mark: CycleMark): boolean {
  return (mark === "T" || mark === "ST") && isDiscordantRepol(finding);
}

/** Reentry rings shown as one continuous pathway vector */
function isLoopSegment(id: SegmentId): boolean {
  return id === "flutter" || id === "avnrtSlow" || id === "avnrtFast";
}

/** Distal terminals — vectors may finish / tip-hold here */
function isTerminalSegment(id: SegmentId): boolean {
  return id === "purkinjeL" || id === "purkinjeR";
}

/** Stable arrow slot: one key per loop circuit; otherwise one per curve */
function pathwayVectorSlotKey(f: ActiveFront): string {
  if (f.id === "flutter") return "loop:flutter";
  if (f.id === "avnrtSlow" || f.id === "avnrtFast") return "loop:avnrt";
  return `${f.id}:${f.curveIndex ?? 0}`;
}

/**
 * Pathway vectors follow mid-tract conduction. Hide at junctions; only tip-hold
 * on Purkinje terminals. Loops keep a single traveling arrow (no per-limb tip).
 */
function pathwayVectorVisible(f: ActiveFront): boolean {
  const p = Math.min(1, Math.max(0, f.progress));
  if (isLoopSegment(f.id)) {
    // One continuous loop arrow — never park on a limb tip
    return !f.tipHold;
  }
  if (isTerminalSegment(f.id)) {
    // Skip the proximal junction; allow arrival at the tip
    return p >= 0.05;
  }
  // Intermediate tracts: no tip-hold display, soft skip of junction beads
  if (f.tipHold) return false;
  if (p < 0.05 || p > 0.95) return false;
  return true;
}

  function updateBranchArrows(
    fronts: ActiveFront[],
    opts: { mark: CycleMark; finding: FindingId; mag: number },
  ) {
    // NSR-style idle: no pathway vectors on TP. AFib keeps atrial fronts live.
    if (opts.mark === "TP" && opts.finding !== "afib") {
      for (let i = 0; i < BRANCH_ARROW_POOL; i++) {
        branchSlotOpacity[i] = Math.max(0, branchSlotOpacity[i]! - 0.06);
        if (branchSlotOpacity[i]! < 0.04) {
          branchArrows[i]!.visible = false;
          branchSlotOpacity[i] = 0;
        } else {
          const a = branchArrows[i]!;
          a.visible = true;
          const lm = a.line.material;
          if (lm instanceof THREE.LineBasicMaterial) lm.opacity = branchSlotOpacity[i]!;
          const cm = a.cone.material;
          if (cm instanceof THREE.MeshBasicMaterial) cm.opacity = branchSlotOpacity[i]!;
        }
      }
      return;
    }

    // Collapse loop limbs to one front; drop junction / tip-hold clutter
    const chosen = new Map<string, ActiveFront>();
    for (const f of fronts) {
      if (!pathwayVectorVisible(f)) continue;
      const key = pathwayVectorSlotKey(f);
      const prev = chosen.get(key);
      if (!prev) {
        chosen.set(key, f);
        continue;
      }
      // Prefer actively mid-tract over anything near an end
      const score = (f: ActiveFront) => {
        const p = Math.min(1, Math.max(0, f.progress));
        const mid = 1 - Math.abs(p - 0.5) * 2;
        return (f.tipHold ? 0 : 2) + mid;
      };
      if (score(f) >= score(prev)) chosen.set(key, f);
    }

    const liveKeys = new Set<string>();
    for (const [key, f] of chosen) {
      liveKeys.add(key);
      let pool = branchSlotToPool.get(key);
      if (pool == null) {
        pool = branchPoolFree.pop();
        if (pool == null) continue;
        branchSlotToPool.set(key, pool);
      }
      let dir = new THREE.Vector3(...f.dir);
      if (dir.lengthSq() < 1e-8) continue;
      dir.normalize();

      const p = Math.min(1, Math.max(0, f.progress));
      // Soft ends only for terminal tip arrival; mid-tract stays full
      const envelope = isTerminalSegment(f.id)
        ? p < 0.12
          ? 0.55 + 0.45 * (p / 0.12)
          : 1
        : p < 0.12
          ? 0.55 + 0.45 * (p / 0.12)
          : p > 0.85
            ? Math.max(0.35, (1 - p) / 0.15)
            : 1;
      const targetOp = 0.55 + 0.4 * envelope;
      const wasDim = (branchSlotOpacity[pool] ?? 0) < 0.1;
      // Slow approach so overlapping AFib wavelets don't flash
      branchSlotOpacity[pool] = Math.min(1, (branchSlotOpacity[pool] ?? 0) * 0.78 + targetOp * 0.22);

      const len = (0.26 + 0.26 * envelope) * (0.75 + 0.35 * opts.mag);
      const arrow = branchArrows[pool]!;
      arrow.visible = true;
      const frontPos = new THREE.Vector3(...f.pos);
      // Loops: lerp harder so limb handoffs read as one continuous glide
      const lerpT = isLoopSegment(f.id) ? 0.55 : wasDim ? 1 : 0.4;
      if (wasDim || lerpT >= 1) arrow.position.copy(frontPos);
      else arrow.position.lerp(frontPos, lerpT);
      arrow.setDirection(dir);
      arrow.setLength(len, len * 0.32, len * 0.2);
      arrow.setColor(f.color);
      const lm = arrow.line.material;
      if (lm instanceof THREE.LineBasicMaterial) lm.opacity = branchSlotOpacity[pool]!;
      const cm = arrow.cone.material;
      if (cm instanceof THREE.MeshBasicMaterial) cm.opacity = branchSlotOpacity[pool]!;
    }

    // Soft-fade slots whose fronts ended (no hard pop-off)
    for (const [key, pool] of [...branchSlotToPool.entries()]) {
      if (liveKeys.has(key)) continue;
      branchSlotOpacity[pool] = Math.max(0, branchSlotOpacity[pool]! - 0.035);
      const arrow = branchArrows[pool]!;
      if (branchSlotOpacity[pool]! < 0.05) {
        arrow.visible = false;
        branchSlotOpacity[pool] = 0;
        branchSlotToPool.delete(key);
        branchPoolFree.push(pool);
      } else {
        arrow.visible = true;
        const lm = arrow.line.material;
        if (lm instanceof THREE.LineBasicMaterial) lm.opacity = branchSlotOpacity[pool]!;
        const cm = arrow.cone.material;
        if (cm instanceof THREE.MeshBasicMaterial) cm.opacity = branchSlotOpacity[pool]!;
      }
    }
  }

  function updatePhysiologic(opts: {
    mark: CycleMark;
    active: SegmentId[];
    finding: FindingId;
    tCycle: number;
    leads?: Partial<Record<LeadId, number>>;
    branches?: BranchWindow[];
    fronts?: ActiveFront[];
    ectopyFocus?: MyocardialFocusOpts | MyocardialFocusOpts[] | null;
    preExcitation?: PreExcitationOpts | null;
    lesionIds?: SegmentId[];
  }) {
    const t = ((opts.tCycle % 1) + 1) % 1;
    const branches = opts.branches ?? branchesForFinding(opts.finding);
    const liveSegments = new Set<SegmentId>();
    const liveGroups = new Set(groupsForMark(opts.mark));
    for (const b of branches) {
      if (t >= b.t0 && t <= b.t1) liveSegments.add(b.id);
    }
    // Also trust EKG active set
    for (const id of opts.active) liveSegments.add(id);
    const isAfib = opts.finding === "afib";
    // AFib f-waves never idle — keep atrial group eligible under every EKG mark
    if (isAfib) {
      liveGroups.add("atrial");
      liveSegments.add("internodal");
      liveSegments.add("myocardiumA");
    }

    // Precompute live fronts for spreading field shells (all rhythms)
    const fieldFronts: { pos: THREE.Vector3; dir: THREE.Vector3; id: SegmentId; atrial: boolean }[] =
      [];
    for (const f of opts.fronts ?? []) {
      const atrial =
        f.id === "sa" ||
        f.id === "internodal" ||
        f.id === "flutter" ||
        f.id === "myocardiumA" ||
        f.id === "avnrtSlow" ||
        f.id === "avnrtFast";
      fieldFronts.push({
        pos: new THREE.Vector3(...f.pos),
        dir: new THREE.Vector3(...f.dir).normalize(),
        id: f.id,
        atrial,
      });
    }
    const liveMeta = new Map<
      SegmentId,
      { group: string; t0: number; t1: number; reverse: boolean }
    >();
    // Pick the single most relevant window per segment at t — never min/max across
    // every beat in a multi-QRS cycle (that stretched actTimes and made fields blink).
    const bySeg = new Map<SegmentId, BranchWindow[]>();
    for (const b of branches) {
      const list = bySeg.get(b.id) ?? [];
      list.push(b);
      bySeg.set(b.id, list);
    }
    const tipHoldMeta = 0.14;
    for (const [id, list] of bySeg) {
      let best: BranchWindow | null = null;
      let bestScore = -Infinity;
      for (const b of list) {
        let score: number;
        if (t >= b.t0 && t <= b.t1 + tipHoldMeta) score = 2000 + b.t0;
        else if (t < b.t0) score = 1000 - (b.t0 - t);
        else score = 500 - (t - b.t1);
        if (score > bestScore) {
          bestScore = score;
          best = b;
        }
      }
      if (!best) continue;
      const reverse = !!best.reverse || (best.u0 != null && best.u1 != null && best.u1 < best.u0);
      liveMeta.set(id, { group: best.group, t0: best.t0, t1: best.t1, reverse });
    }

    const lesions = new Set(opts.lesionIds ?? []);
    const delayRight =
      opts.finding === "rbbb" ||
      opts.finding === "rbbbLafb" ||
      opts.finding === "rbbbLpfb" ||
      lesions.has("rbb")
        ? 0.06
        : 0;
    const delayLeft =
      opts.finding === "lbbb" || lesions.has("lbb") || (lesions.has("lbba") && lesions.has("lbbp"))
        ? 0.06
        : 0;
    const delayLaf = opts.finding === "lafb" || opts.finding === "rbbbLafb" || lesions.has("lbba") ? 0.045 : 0;
    const delayLpf = opts.finding === "lpfb" || opts.finding === "rbbbLpfb" || lesions.has("lbbp") ? 0.045 : 0;
    const isRepol = opts.mark === "T" || opts.mark === "ST";
    const flipRepol = repolFlipsDepol(opts.finding, opts.mark);
    const mag = ekgMagnitude(opts.leads);

    const foci = normalizeFoci(opts.ectopyFocus);
    const preEx = opts.preExcitation ?? null;
    const preExPos = preEx ? new THREE.Vector3(...preEx.pos) : null;
    const preExT0 = preEx?.t0 ?? 0;
    const preExT1 = preEx?.t1 ?? 0.38;
    const preExColor = preEx?.color ?? 0xc070ff;
    const preExLive =
      !!preEx &&
      (opts.mark === "PR" || opts.mark === "QRS") &&
      t >= preExT0 &&
      t <= preExT1 + 0.08;

    type LiveFocus = {
      pos: THREE.Vector3;
      color: number;
      t0: number;
      speed: number;
      waveDur: number;
      fireDur: number;
      tissue: "atrial" | "ventricular";
      since: number;
      waveActive: boolean;
      firing: boolean;
    };
    const liveFoci: LiveFocus[] = foci.map((f) => {
      let since = t - (f.t0 ?? 0.22);
      if (since < -0.5) since += 1;
      if (since > 0.5) since -= 1;
      const waveDur = f.waveDur ?? (opts.finding === "pvc" ? 0.38 : 0.55);
      const fireDur = f.fireDur ?? 0.14;
      return {
        pos: new THREE.Vector3(...f.pos),
        color: f.color ?? 0xff8844,
        t0: f.t0 ?? 0.22,
        speed: f.speed ?? 0.55,
        waveDur,
        fireDur,
        tissue: f.tissue ?? "ventricular",
        since,
        waveActive: since >= -0.02 && since <= waveDur,
        firing: since >= -0.01 && since <= fireDur,
      };
    });

    if (meanGroup.visible) {
      updateBranchArrows(opts.fronts ?? [], {
        mark: opts.mark,
        finding: opts.finding,
        mag,
      });
    } else {
      for (const a of branchArrows) a.visible = false;
    }

    // Show insulator whenever field is on
    insulator.visible = fieldGroup.visible;
    hisGap.visible = fieldGroup.visible;

    // One focus marker per pace lead / ectopy site
    for (let i = 0; i < FOCUS_POOL; i++) {
      const marker = focusMarkers[i]!;
      const ring = focusRings[i]!;
      const focus = liveFoci[i];
      const show =
        fieldGroup.visible &&
        ((focus && !preExLive) || (i === 0 && preExLive && !!preExPos));
      marker.visible = !!show;
      ring.visible = !!show;
      if (!show) continue;

      const raw = preExLive && preExPos && i === 0 ? preExPos : focus!.pos;
      const fp = new THREE.Vector3(...projectOntoMyocardialShell([raw.x, raw.y, raw.z]));
      const n = ellipsoidNormal(fp);
      fp.addScaledVector(n, 0.028);
      const fc = preExLive && i === 0 ? preExColor : focus!.color;
      marker.position.copy(fp);
      (marker.material as THREE.MeshBasicMaterial).color.setHex(fc);
      ring.position.copy(fp);
      focusRingQuat.setFromUnitVectors(focusRingZ, n);
      ring.quaternion.copy(focusRingQuat);
      (ring.material as THREE.MeshBasicMaterial).color.setHex(fc);

      const fire =
        preExLive && i === 0
          ? Math.max(0, 1 - Math.abs(t - preExT0) / 0.12)
          : focus!.firing
            ? Math.sin(Math.min(1, Math.max(0, focus!.since) / Math.max(1e-4, focus!.fireDur)) * Math.PI)
            : 0;
      const idle = 0.92 + 0.06 * Math.sin(t * Math.PI * 4 + i);
      marker.scale.setScalar(idle + 1.35 * fire);
      ring.scale.setScalar(0.95 + 0.55 * fire);
      (marker.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.4 * fire;
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.4 + 0.45 * fire;
    }

    tmpSum.set(0, 0, 0);
    tmpOrigin.set(0, 0, 0);
    let nActive = 0;
    let nMyo = 0;
    let nOrigin = 0;

    // Impulse fronts drive the resultant whenever they are live — including retrograde
    // atrial / Kent limbs that the EKG marks as ST or T (P-on-T). Pure myocardial
    // recovery (no fronts) falls through to ± QRS axis below.
    if (meanGroup.visible && !!opts.fronts?.length && opts.mark !== "TP") {
      const fronts = opts.fronts!;
      const hasReverse = fronts.some((f) => f.reverse);
      for (const f of fronts) {
        // When a retrograde limb is lit, don't let leftover anterograde Purkinje
        // drown the mean (AVNRT/AVRT upstroke should point superior).
        if (hasReverse && !f.reverse) continue;
        let dir = new THREE.Vector3(...f.dir);
        if (dir.lengthSq() < 1e-8) continue;
        dir.normalize();
        const p = Math.min(1, Math.max(0, f.progress));
        const envelope = p < 0.12 ? p / 0.12 : 1;
        const w = (0.35 + 0.65 * envelope) * frontMass(f.id) * (f.reverse ? 1.35 : 1);
        tmpSum.addScaledVector(dir, w);
        tmpOrigin.addScaledVector(new THREE.Vector3(...f.pos), w);
        nActive += w;
        nOrigin += w;
      }
    }

    for (const s of samples) {
      if (s.tissue === "insulator") {
        if (fieldGroup.visible) {
          s.arrow.visible = true;
          s.arrow.position.copy(s.pos);
          s.arrow.setDirection(new THREE.Vector3(0, 1, 0));
          s.arrow.setLength(0.035, 0.018, 0.012);
          s.arrow.setColor(0x9aa4ae);
          const lm = s.arrow.line.material;
          if (lm instanceof THREE.LineBasicMaterial) lm.opacity = 0.16;
        } else {
          s.arrow.visible = false;
        }
        continue;
      }

      let act = s.actTime;
      const lmLive = liveMeta.get(s.nearestId);
      if (lmLive) {
        // Live finding/stim window; pathU places the front along the tract
        const uFrac = lmLive.reverse ? 1 - s.pathU : s.pathU;
        act = lmLive.t0 + uFrac * (lmLive.t1 - lmLive.t0);
      }

      // Field-first myocardial capture: expanding shell from each pace / ectopy tip.
      // Distance is along the ovoid face (not through the cavity) so the wave
      // can't teleport to the opposite wall.
      let fromMyoFocus = false;
      let engagedTract = false;
      let focusColor: number | null = null;
      let focusDir: THREE.Vector3 | null = null;
      let shellReached = false;
      let anyEctopyWave = false;
      for (const focus of liveFoci) {
        if (!focus.waveActive || isRepol) continue;
        const tissueOk =
          s.tissue === focus.tissue ||
          (focus.tissue === "atrial" && (s.nearestId === "av" || s.nearestId === "internodal"));
        if (!tissueOk) continue;
        anyEctopyWave = true;
        const dFocus = shellArcDistance(focus.pos, s.pos);
        const fieldAct = focus.t0 + dFocus * focus.speed;
        const radiusNow = Math.max(0, focus.since / Math.max(1e-4, focus.speed));
        const reached = dFocus <= radiusNow + 0.05;
        if (reached) shellReached = true;
        const tractReady =
          reached &&
          focus.tissue === "ventricular" &&
          !!lmLive &&
          t >= lmLive.t0 &&
          (lmLive.group === "ectopy" ||
            s.nearestId === "purkinjeL" ||
            s.nearestId === "purkinjeR" ||
            s.nearestId === "rbb" ||
            s.nearestId === "lbb" ||
            s.nearestId === "lbba" ||
            s.nearestId === "lbbp");

        if (reached || fieldAct <= t + 0.02) {
          if (!fromMyoFocus || fieldAct < act) {
            act = fieldAct;
            fromMyoFocus = true;
            focusColor = focus.color;
            const outward = s.pos.clone().sub(focus.pos);
            if (outward.lengthSq() > 1e-8) {
              focusDir = projectOntoShellTangent(outward, s.pos);
            }
          }
        }
        if (tractReady) engagedTract = true;
      }
      // Antidromic pre-excitation: slow wide field from Kent ventricular tip
      if (preExLive && preExPos && (s.tissue === "ventricular" || s.nearestId === "accessory" || s.nearestId === "accessoryR") && !isRepol) {
        const dFocus = s.pos.distanceTo(preExPos);
        const fieldAct = preExT0 + dFocus * 0.72;
        if (fieldAct <= preExT1 + 0.12 && (!lmLive || fieldAct <= act + 0.04 || s.nearestId === "accessory" || s.nearestId === "accessoryR")) {
          act = Math.min(act, fieldAct);
          fromMyoFocus = true;
          focusColor = preExColor;
          const outward = s.pos.clone().sub(preExPos);
          if (outward.lengthSq() > 1e-8) {
            focusDir = projectOntoShellTangent(outward, s.pos);
          }
        }
      }

      if (delayRight && (s.nearestId === "rbb" || s.nearestId === "purkinjeR" || s.pos.x < -0.1)) {
        act += delayRight;
      }
      if (
        delayLeft &&
        (s.nearestId === "lbb" ||
          s.nearestId === "lbba" ||
          s.nearestId === "lbbp" ||
          s.nearestId === "purkinjeL" ||
          s.pos.x > 0.12)
      ) {
        act += delayLeft;
      }
      if (delayLaf && (s.nearestId === "lbba" || (s.pos.x > 0.2 && s.pos.y > -0.7 && s.pos.z > 0.05))) {
        act += delayLaf;
      }
      if (delayLpf && (s.nearestId === "lbbp" || (s.pos.x > 0.1 && s.pos.y < -0.75 && s.pos.z < 0.08))) {
        act += delayLpf;
      }

      // Lesioned tracts stay dark in the field overlay
      if (lesions.has(s.nearestId) && !fromMyoFocus) {
        if (fieldGroup.visible) {
          s.arrow.visible = true;
          s.arrow.position.copy(s.pos);
          s.arrow.setDirection(s.dir);
          s.arrow.setLength(0.04, 0.02, 0.014);
          s.arrow.setColor(0x3a4048);
          const lm = s.arrow.line.material;
          if (lm instanceof THREE.LineBasicMaterial) lm.opacity = 0.22;
        } else {
          s.arrow.visible = false;
        }
        continue;
      }

      // Repolarization wave follows depol with delay (~ST/T)
      const repolTime = act + 0.18;
      const eventTime = isRepol ? repolTime : act;
      // Cycle-aware age so the wave soft-decays instead of hard cut
      let age = t - eventTime;
      if (age < -0.5) age += 1;
      if (age > 0.5) age -= 1;

      const meta = liveMeta.get(s.nearestId) ?? branchMeta.get(s.nearestId);
      const groupOk =
        fromMyoFocus ||
        liveGroups.size === 0 ||
        !meta ||
        liveGroups.has(meta.group) ||
        liveSegments.has(s.nearestId);

      const pathwayLive = liveSegments.has(s.nearestId);

      // Chamber gating from EKG mark
      let chamberOk = true;
      if (
        opts.mark === "P" ||
        (opts.mark === "PR" &&
          opts.finding !== "avrtAntiLeft" &&
          opts.finding !== "avrtAntiRight")
      ) {
        chamberOk = s.tissue === "atrial" || s.nearestId === "av" || s.nearestId === "his";
      } else if (opts.mark === "QRS" || opts.mark === "ST" || opts.mark === "T") {
        chamberOk =
          s.tissue === "ventricular" ||
          s.nearestId === "his" ||
          s.nearestId === "accessory" ||
          s.nearestId === "accessoryR" ||
          opts.finding === "av3" ||
          opts.finding === "av3Junctional";
        if (isAfib && s.tissue === "atrial") chamberOk = true;
      } else if (opts.mark === "TP") {
        chamberOk = isAfib && s.tissue === "atrial";
      }
      if (
        (opts.finding === "avrtAntiLeft" || opts.finding === "avrtAntiRight") &&
        opts.mark === "PR" &&
        (s.nearestId === "accessory" ||
          s.nearestId === "accessoryR" ||
          s.tissue === "ventricular" ||
          fromMyoFocus)
      ) {
        chamberOk = true;
      }
      if (opts.finding === "vt" || fromMyoFocus) {
        chamberOk = s.tissue === "ventricular" || s.nearestId === "accessory" || s.nearestId === "accessoryR";
      }

      // Spreading field shell: bright near each live front, long dissipating trail behind.
      // Same model for atria and ventricles, all rhythms (incl. AFib wavelets).
      let frontIntensity = 0;
      let frontDir: THREE.Vector3 | null = null;
      if (chamberOk && fieldFronts.length) {
        const wantAtrial = s.tissue === "atrial";
        for (const f of fieldFronts) {
          if (wantAtrial !== f.atrial && f.id !== "his" && f.id !== "av") continue;
          if (!wantAtrial && f.atrial) continue;
          tmpToFront.copy(s.pos).sub(f.pos);
          const along = tmpToFront.dot(f.dir);
          const lat = tmpToFront.lengthSq() - along * along;
          const latD = lat > 0 ? Math.sqrt(lat) : 0;
          // Lead tip slightly ahead; long wake trailing opposite travel
          const lead = wantAtrial ? 0.1 : 0.14;
          const wake = wantAtrial ? 0.42 : 0.5;
          const sigma = wantAtrial ? 0.16 : 0.2;
          if (along > lead || along < -wake || latD > sigma * 2.8) continue;
          const alongW =
            along >= 0
              ? Math.exp(-(along * along) / (2 * lead * lead * 0.55))
              : Math.exp(along / (wake * 0.55));
          const latW = Math.exp(-(latD * latD) / (2 * sigma * sigma));
          const w = alongW * latW;
          if (w > frontIntensity) {
            frontIntensity = w;
            frontDir = f.dir.clone().lerp(s.dir, 0.22);
            projectOntoShellTangent(frontDir, s.pos);
          }
        }
      }

      // Activation deposit: pathway vs myocardial focus tracked separately so
      // color / direction / magnitude can blend as the PVC wave joins the tracts.
      const rise = fromMyoFocus ? 0.06 : 0.04;
      let pathDeposit = 0;
      let pvcDeposit = 0;
      if (age >= -rise && age <= 0.14) {
        const d = age < 0 ? 0.4 + 0.6 * (1 + age / rise) : Math.exp(-age / 0.09);
        if (fromMyoFocus) pvcDeposit = d;
        else pathDeposit = d;
      }
      if (pathwayLive && Math.abs(age) < 0.1 && !fromMyoFocus) {
        pathDeposit = Math.max(pathDeposit, 0.35);
      }
      if (fromMyoFocus && focusDir) {
        // Long soft wake behind the expanding myocardial front
        pvcDeposit = Math.max(pvcDeposit, 0.78 * Math.max(0, 1 - Math.max(0, age) / 0.2));
      }
      if (engagedTract) {
        pathDeposit = Math.max(pathDeposit, 0.55);
        pvcDeposit = Math.max(pvcDeposit, 0.4);
      }

      let pathDrive =
        chamberOk && (groupOk || frontIntensity > 0.08 || engagedTract)
          ? Math.max(
              frontIntensity * (fromMyoFocus ? 0.6 : 1),
              pathDeposit * (frontIntensity > 0.05 ? 0.55 : 0.9),
              engagedTract ? 0.5 : 0,
            )
          : 0;
      // During a PVC / pace wave, myocardium ahead of the shell front must not light from
      // remapped pathway timing (that caused the far-wall jump). Local fronts still blend.
      if (anyEctopyWave && s.tissue === "ventricular" && !shellReached && !fromMyoFocus) {
        pathDrive = frontIntensity > 0.14 ? frontIntensity * 0.75 : 0;
      }
      const pvcDrive =
        chamberOk && (fromMyoFocus || engagedTract)
          ? Math.max(pvcDeposit, engagedTract ? 0.3 : 0)
          : 0;

      s.glow = Math.max(s.glow * 0.968, Math.max(pathDrive, pvcDrive));
      if (!chamberOk) s.glow *= 0.9;

      const blendTarget =
        pathDrive + pvcDrive < 1e-4 ? s.pvcBlend * 0.9 : pvcDrive / (pathDrive + pvcDrive + 1e-6);
      s.pvcBlend = s.pvcBlend * 0.8 + blendTarget * 0.2;
      if (!chamberOk) s.pvcBlend *= 0.9;

      const intensity = s.glow * (0.85 + 0.2 * Math.max(pathDrive, pvcDrive));
      const show = intensity > 0.08;

      let pathDir = frontDir ? frontDir.clone() : s.dir.clone();
      if (!frontDir && lmLive?.reverse) pathDir.negate();
      if (!frontDir && isRepol && !(isAfib && s.tissue === "atrial")) {
        pathDir.copy(s.dir);
        if (flipRepol) pathDir.negate();
        projectOntoShellTangent(pathDir, s.pos);
      } else if (!frontDir) {
        projectOntoShellTangent(pathDir, s.pos);
      }

      let dir = pathDir;
      if (focusDir && s.pvcBlend > 0.05) {
        dir = pathDir.clone().lerp(focusDir, s.pvcBlend);
        projectOntoShellTangent(dir, s.pos);
      }
      if (dir.lengthSq() > 1e-8) {
        s.dirSmooth.lerp(dir, show ? 0.22 : 0.08);
        if (s.dirSmooth.lengthSq() > 1e-8) s.dirSmooth.normalize();
        dir.copy(s.dirSmooth);
      }

      const ectopyHex = focusColor ?? 0xff8844;
      const blendCol = new THREE.Color(s.nearestColor).lerp(new THREE.Color(ectopyHex), s.pvcBlend);
      const displayColor =
        isRepol && s.tissue === "ventricular" && !isAfib ? 0x8eb0ff : blendCol.getHex();

      if (fieldGroup.visible) {
        if (!show) {
          s.arrow.visible = false;
        } else {
          const len =
            (0.09 + 0.17 * intensity) * (fromMyoFocus || engagedTract ? 1.08 + 0.08 * s.pvcBlend : 1);
          s.arrow.visible = true;
          s.arrow.position.copy(s.pos);
          s.arrow.setDirection(dir);
          s.arrow.setLength(len, len * 0.32, len * 0.2);
          s.arrow.setColor(displayColor);
          const lm = s.arrow.line.material;
          if (lm instanceof THREE.LineBasicMaterial) {
            lm.opacity = 0.22 + 0.72 * intensity;
          }
        }
      } else {
        s.arrow.visible = false;
        s.glow = 0;
        s.pvcBlend = 0;
      }

      // Myocardial samples: origin during recovery; light mass during depol fallback.
      if (meanGroup.visible && show && intensity > 0.12 && chamberOk) {
        const mass =
          fromMyoFocus || engagedTract
            ? 1.8
            : s.tissue === "ventricular" && s.pos.x > 0.05
              ? 1.55
              : s.tissue === "atrial"
                ? 0.55
                : 1;
        const w = intensity * intensity * mass;
        if (!isRepol) {
          tmpSum.addScaledVector(dir, w * 0.5);
          nMyo += w * 0.5;
          if (nActive < 0.01) {
            tmpOrigin.addScaledVector(s.pos, w);
            nOrigin += w;
          }
        } else {
          nMyo += w;
          tmpOrigin.addScaledVector(s.pos, w);
          nOrigin += w;
        }
      }
    }

    // Mean arrow: direction + strength from the same lead voltages as the EKG strip;
    // origin still tracks the activation / recovery front.
    if (meanGroup.visible) {
      const fromLeads = meanFromLeads(opts.leads);
      const hasFronts = nActive > 0.01 && tmpSum.lengthSq() > 1e-8;
      const hasMyoDepol = !isRepol && nMyo > 0.01 && tmpSum.lengthSq() > 1e-8;
      let targetDir = smoothMeanDir.clone();
      let targetStrength = 0;
      let targetColor = 0x3db8c8;
      let targetWave = 0x88f0c0;
      let hasSignal = false;

      if (fromLeads && fromLeads.strength > 0.025) {
        // Matches I / II / aVF / V1–V6 at the scrub cursor (including T-wave size)
        targetDir = fromLeads.dir;
        targetStrength = fromLeads.strength;
        hasSignal = true;
        if (isAfib && (opts.mark === "TP" || opts.mark === "P")) {
          // Fine f-wave atrial mean
          targetStrength = Math.min(0.5, 0.2 + fromLeads.strength);
          targetColor = 0xe8a838;
          targetWave = 0xe8a838;
        } else {
          targetColor =
            opts.mark === "P" || opts.mark === "PR"
              ? 0xf0c040
              : opts.mark === "T"
                ? 0x8eb0ff
                : opts.mark === "ST"
                  ? 0x6ec896
                  : 0x3db8c8;
          targetWave =
            opts.mark === "P" || opts.mark === "PR"
              ? 0xf0c040
              : opts.mark === "T" || opts.mark === "ST"
                ? 0x8eb0ff
                : 0x88f0c0;
        }
      } else if (hasFronts || hasMyoDepol) {
        // Fallback if leads are flat — anatomic travel
        targetDir = tmpSum.clone().normalize();
        targetStrength = Math.min(1.35, 0.28 + Math.sqrt(hasFronts ? nActive : nMyo) * 0.22);
        hasSignal = true;
        targetColor = opts.mark === "P" || opts.mark === "PR" ? 0xf0c040 : 0x3db8c8;
        targetWave = opts.mark === "P" || opts.mark === "PR" ? 0xf0c040 : 0x88f0c0;
      } else if (opts.mark === "TP") {
        if (isAfib && fromLeads && fromLeads.strength > 0.01) {
          // Fine f-wave dipole — keep a small atrial mean alive between QRS
          targetDir = fromLeads.dir;
          targetStrength = Math.min(0.45, 0.18 + fromLeads.strength * 0.9);
          hasSignal = true;
          targetColor = 0xe8a838;
          targetWave = 0xe8a838;
        } else {
          targetStrength = 0;
          hasSignal = true;
        }
      }

      if (!smoothMeanReady) {
        if (hasSignal && targetStrength > 0.02) smoothMeanDir.copy(targetDir);
        smoothMeanStrength = targetStrength;
        smoothMeanColor.setHex(targetColor);
        smoothWaveColor.setHex(targetWave);
        smoothMeanReady = true;
      } else {
        if (hasSignal && targetStrength > 0.02) {
          // Responsive so scrubbing the strip updates the arrow with the leads
          smoothMeanDir.lerp(targetDir, 0.32);
          if (smoothMeanDir.lengthSq() > 1e-8) smoothMeanDir.normalize();
        }
        const sFollow = targetStrength >= smoothMeanStrength ? 0.32 : 0.2;
        smoothMeanStrength += (targetStrength - smoothMeanStrength) * sFollow;
        smoothMeanColor.lerp(new THREE.Color(targetColor), 0.18);
        smoothWaveColor.lerp(new THREE.Color(targetWave), 0.18);
      }

      const originWeight = nOrigin;
      if (originWeight > 0.01) {
        const targetOrigin = tmpOrigin.clone().multiplyScalar(1 / originWeight);
        smoothMeanOrigin.lerp(targetOrigin, 0.22);
      } else if (isAfib && (opts.mark === "TP" || opts.mark === "P")) {
        // Park the atrial mean in the RA/LA mass (not a ventricular wavefront origin)
        smoothMeanOrigin.lerp(new THREE.Vector3(-0.28, 0.32, 0.08), 0.12);
      } else if (isRepol) {
        smoothMeanOrigin.lerp(new THREE.Vector3(0.06, -0.35, 0.08), 0.08);
      }

      const baseLen =
        opts.mark === "QRS"
          ? 1.45
          : opts.mark === "T"
            ? 1.15
            : opts.mark === "P" || opts.mark === "PR"
              ? 0.95
              : opts.mark === "ST"
                ? 0.75
                : isAfib
                  ? 0.55
                  : 0.7;
      const s = Math.max(0, smoothMeanStrength);
      const len = Math.max(0.05, baseLen * Math.max(0.04, s));
      const opacity = Math.min(0.92, 0.1 + 0.8 * Math.min(1, s));

      meanArrow.visible = true;
      meanArrow.position.copy(smoothMeanOrigin);
      meanArrow.setDirection(smoothMeanDir);
      meanArrow.setLength(len, len * 0.24, len * 0.14);
      meanArrow.setColor(smoothMeanColor.getHex());
      const lm = meanArrow.line.material;
      if (lm instanceof THREE.LineBasicMaterial) lm.opacity = opacity;
      const cm = meanArrow.cone.material;
      if (cm instanceof THREE.MeshBasicMaterial) cm.opacity = opacity;

      // Wavefront ring = organized activation sheet. Hide during AFib f-waves
      // (no coherent front); show only for irregular QRS / recovery.
      const showWaveRing =
        !(isAfib && (opts.mark === "TP" || opts.mark === "P")) && Math.max(0, 0.03 + 0.22 * Math.min(1, s)) > 0.04;
      const waveOpacity = showWaveRing ? Math.max(0, 0.03 + 0.22 * Math.min(1, s)) : 0;
      wavefront.visible = waveOpacity > 0.04;
      if (wavefront.visible) {
        wavefront.position.copy(smoothMeanOrigin);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), smoothMeanDir);
        wavefront.quaternion.copy(q);
        wavefront.scale.setScalar(0.32 + 0.35 * Math.min(1, s));
        waveMat.color.copy(smoothWaveColor);
        waveMat.opacity = waveOpacity;
      }
    } else {
      meanArrow.visible = false;
      wavefront.visible = false;
      smoothMeanReady = false;
      smoothMeanStrength = 0;
    }
  }

  function update(opts: {
    mark: CycleMark;
    active: SegmentId[];
    finding: FindingId;
    tCycle: number;
    leads?: Partial<Record<LeadId, number>>;
    branches?: BranchWindow[];
    fronts?: ActiveFront[];
    ectopyFocus?: MyocardialFocusOpts | MyocardialFocusOpts[] | null;
    preExcitation?: PreExcitationOpts | null;
    lesionIds?: SegmentId[];
  }) {
    // Always run physics when either overlay is visible so mean tracks the field
    if (!meanGroup.visible && !fieldGroup.visible) {
      meanArrow.visible = false;
      wavefront.visible = false;
      smoothMeanReady = false;
      smoothMeanStrength = 0;
      for (const m of focusMarkers) m.visible = false;
      for (const r of focusRings) r.visible = false;
      for (const a of branchArrows) a.visible = false;
      for (const s of samples) s.arrow.visible = false;
      return;
    }
    updatePhysiologic(opts);
  }

  return {
    root,
    setMeanVisible: (v: boolean) => {
      meanGroup.visible = v;
      if (!v) {
        smoothMeanReady = false;
        smoothMeanStrength = 0;
      }
    },
    setFieldVisible: (v: boolean) => {
      fieldGroup.visible = v;
    },
    update,
  };
}
