import * as THREE from "three";
import type { CycleMark, LeadId } from "./ekgWaveforms";
import type { FindingId, SegmentId } from "./findings";
import { FIELD_ELLIPSOID } from "./conductionAnatomy";
import { fitCardiacVector } from "./leadAxes";
import type { ActiveFront, BranchWindow, PathwayProbePoint } from "./pathwayTiming";
import { branchesForFinding, groupsForMark } from "./pathwayTiming";

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
  }) => void;
};

type FieldSample = {
  pos: THREE.Vector3;
  tissue: "atrial" | "ventricular" | "insulator";
  nearestId: SegmentId;
  nearestColor: number;
  dir: THREE.Vector3;
  /** Parametric position along nearest pathway (0–1) */
  pathU: number;
  /** Depolarization arrival time (NSR-baked; remapped live) */
  actTime: number;
  arrow: THREE.ArrowHelper;
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

  for (let ix = -4; ix <= 4; ix++) {
    for (let iy = -5; iy <= 4; iy++) {
      for (let iz = -3; iz <= 3; iz++) {
        const x = ix * 0.22;
        const y = iy * 0.2 - 0.15;
        const z = iz * 0.22;
        const nx = x / FIELD_ELLIPSOID.radius.x;
        const ny = (y - FIELD_ELLIPSOID.center.y) / FIELD_ELLIPSOID.radius.y;
        const nz = z / FIELD_ELLIPSOID.radius.z;
        if (nx * nx + ny * ny + nz * nz > FIELD_ELLIPSOID.limit) continue;

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
          samples.push({
            pos,
            tissue,
            nearestId: "his",
            nearestColor: 0x9aa4ae,
            dir: new THREE.Vector3(0, 1, 0),
            pathU: 0,
            actTime: 99,
            arrow,
          });
          continue;
        }

        const { idx, dist } = nearestProbe(pos, tissue);
        const pr = probes[idx]!;
        const tangent = probeTan[idx]!.clone();
        const outward = pos.clone().sub(probePos[idx]!);
        if (outward.lengthSq() > 1e-8) outward.normalize();
        else outward.set(0, 0, 0);
        const dir = tangent.clone().multiplyScalar(0.7).add(outward.multiplyScalar(0.3));
        if (dir.lengthSq() < 1e-6) dir.copy(tangent);
        else dir.normalize();

        const pathTime = pr.enterT + (pr.exitT - pr.enterT) * pr.pathU;
        const actTime = pathTime + dist * 0.42;

        samples.push({
          pos,
          tissue,
          nearestId: pr.segmentId,
          nearestColor: pr.color,
          dir,
          pathU: pr.pathU,
          actTime,
          arrow,
        });
      }
    }
  }

  root.add(meanGroup, fieldGroup);

  const tmpSum = new THREE.Vector3();
  const tmpOrigin = new THREE.Vector3();
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

  function updateBranchArrows(
    fronts: ActiveFront[],
    opts: { mark: CycleMark; finding: FindingId; mag: number },
  ) {
    // Only clear during TP — fascicles/Purkinje finish into early ST; hiding on ST
    // made those arrows vanish before they reached the tip.
    if (opts.mark === "TP") {
      for (const arrow of branchArrows) arrow.visible = false;
      return;
    }

    for (let i = 0; i < branchArrows.length; i++) {
      const arrow = branchArrows[i]!;
      const f = fronts[i];
      if (!f) {
        arrow.visible = false;
        continue;
      }
      let dir = new THREE.Vector3(...f.dir);
      if (dir.lengthSq() < 1e-8) {
        arrow.visible = false;
        continue;
      }
      dir.normalize();

      // Rise early, then hold full strength through the tip
      const p = Math.min(1, Math.max(0, f.progress));
      const envelope = p < 0.12 ? 0.4 + 0.6 * (p / 0.12) : 1;
      const len = (0.28 + 0.28 * envelope) * (0.75 + 0.35 * opts.mag);
      arrow.visible = true;
      arrow.position.set(...f.pos);
      arrow.setDirection(dir);
      arrow.setLength(len, len * 0.32, len * 0.2);
      arrow.setColor(f.color);
      const lm = arrow.line.material;
      if (lm instanceof THREE.LineBasicMaterial) {
        lm.opacity = 0.55 + 0.4 * envelope;
      }
      const cm = arrow.cone.material;
      if (cm instanceof THREE.MeshBasicMaterial) {
        cm.opacity = 0.55 + 0.4 * envelope;
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

    const liveMeta = new Map<
      SegmentId,
      { group: string; t0: number; t1: number; reverse: boolean }
    >();
    for (const b of branches) {
      const prev = liveMeta.get(b.id);
      const reverse = !!b.reverse || (b.u0 != null && b.u1 != null && b.u1 < b.u0);
      if (!prev) liveMeta.set(b.id, { group: b.group, t0: b.t0, t1: b.t1, reverse });
      else {
        liveMeta.set(b.id, {
          group: b.group,
          t0: Math.min(prev.t0, b.t0),
          t1: Math.max(prev.t1, b.t1),
          reverse: prev.reverse || reverse,
        });
      }
    }

    const delayRight = opts.finding === "rbbb" ? 0.06 : 0;
    const delayLeft = opts.finding === "lbbb" ? 0.06 : 0;
    const isRepol = opts.mark === "T" || opts.mark === "ST";
    const flipRepol = repolFlipsDepol(opts.finding, opts.mark);
    const mag = ekgMagnitude(opts.leads);

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

      // Repolarization wave follows depol with delay (~ST/T)
      const repolTime = act + 0.18;
      const eventTime = isRepol ? repolTime : act;
      const dist = t - eventTime;

      const meta = liveMeta.get(s.nearestId) ?? branchMeta.get(s.nearestId);
      const groupOk =
        liveGroups.size === 0 ||
        !meta ||
        liveGroups.has(meta.group) ||
        liveSegments.has(s.nearestId);

      // Continuous wavefront envelope (physiologic width ~40–50 ms of cycle)
      const frontWidth = isRepol ? 0.07 : 0.05;
      const onFront = Math.abs(dist) < frontWidth;
      const justPassed = dist > 0 && dist < frontWidth * 2.2;
      const approaching = dist < 0 && dist > -frontWidth * 0.8;
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
      } else if (opts.mark === "TP") {
        chamberOk = false;
      }
      if (
        (opts.finding === "avrtAntiLeft" || opts.finding === "avrtAntiRight") &&
        opts.mark === "PR" &&
        (s.nearestId === "accessory" || s.nearestId === "accessoryR")
      ) {
        chamberOk = true;
      }
      if (opts.finding === "vt" || opts.finding === "pvc") {
        chamberOk = s.tissue === "ventricular";
      }

      const show =
        chamberOk &&
        groupOk &&
        (onFront || justPassed || approaching || (pathwayLive && Math.abs(dist) < 0.12));

      // Direction: depol along pathway travel; during ST/T align with the EKG dipole.
      let dir = s.dir.clone();
      if (lmLive?.reverse) dir.negate();
      if (isRepol) {
        const leadDipole = meanFromLeads(opts.leads);
        if (leadDipole && leadDipole.strength > 0.04) dir.copy(leadDipole.dir);
        else if (flipRepol) dir.negate();
      }

      // Dynamic length/opacity from how centered we are on the wavefront
      const closeness = Math.exp(-((dist * dist) / (2 * frontWidth * frontWidth)));
      const intensity = Math.max(closeness, pathwayLive && Math.abs(dist) < 0.1 ? 0.55 : 0);

      if (fieldGroup.visible) {
        if (!show || intensity < 0.12) {
          s.arrow.visible = false;
        } else {
          const len = 0.1 + 0.16 * intensity;
          s.arrow.visible = true;
          s.arrow.position.copy(s.pos);
          s.arrow.setDirection(dir);
          s.arrow.setLength(len, len * 0.32, len * 0.2);
          s.arrow.setColor(isRepol ? 0x8eb0ff : s.nearestColor);
          const lm = s.arrow.line.material;
          if (lm instanceof THREE.LineBasicMaterial) {
            lm.opacity = 0.25 + 0.7 * intensity;
          }
        }
      } else {
        s.arrow.visible = false;
      }

      // Myocardial samples: origin during recovery; light mass during depol fallback.
      if (meanGroup.visible && show && intensity > 0.12 && chamberOk) {
        const mass = s.tissue === "ventricular" && s.pos.x > 0.05 ? 1.55 : s.tissue === "atrial" ? 0.55 : 1;
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
      } else if (hasFronts || hasMyoDepol) {
        // Fallback if leads are flat — anatomic travel
        targetDir = tmpSum.clone().normalize();
        targetStrength = Math.min(1.35, 0.28 + Math.sqrt(hasFronts ? nActive : nMyo) * 0.22);
        hasSignal = true;
        targetColor = opts.mark === "P" || opts.mark === "PR" ? 0xf0c040 : 0x3db8c8;
        targetWave = opts.mark === "P" || opts.mark === "PR" ? 0xf0c040 : 0x88f0c0;
      } else if (opts.mark === "TP") {
        targetStrength = 0;
        hasSignal = true;
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

      const waveOpacity = Math.max(0, 0.03 + 0.22 * Math.min(1, s));
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
  }) {
    // Always run physics when either overlay is visible so mean tracks the field
    if (!meanGroup.visible && !fieldGroup.visible) {
      meanArrow.visible = false;
      wavefront.visible = false;
      smoothMeanReady = false;
      smoothMeanStrength = 0;
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
