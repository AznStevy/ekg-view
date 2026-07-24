import * as THREE from "three";
import type { CycleMark, LeadId } from "./ekgWaveforms";
import type { FindingId, SegmentId } from "./findings";
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

/**
 * Mean + field vectors driven by the same physiologic timeline as the EKG / impulse.
 * Instantaneous mean axis = vector sum of currently activating myocardium.
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

  const meanArrow = makeArrow(0xf0c040, 1.2);
  const lateArrow = makeArrow(0xc070ff, 0.7);
  meanGroup.add(meanArrow, lateArrow);

  /** One arrow per currently activating anatomic branch (travel direction) */
  const BRANCH_ARROW_POOL = 32;
  const branchArrows: THREE.ArrowHelper[] = [];
  for (let i = 0; i < BRANCH_ARROW_POOL; i++) {
    const a = makeArrow(0x3db8c8, 0.45);
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
        id === "accessory";
      if (tissue === "atrial" && !atrialSeg && id !== "his") continue;
      if (tissue === "ventricular" && atrialSeg && id !== "accessory") continue;
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
        const nx = x / 1.05;
        const ny = (y + 0.15) / 1.15;
        const nz = z / 0.95;
        if (nx * nx + ny * ny + nz * nz > 0.95) continue;

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
  const tmpLate = new THREE.Vector3();
  const tmpOrigin = new THREE.Vector3();

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
    case "pvc":
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
    case "vtPoly":
    case "torsades":
    case "vf":
    case "pacedVentricular":
    case "pacedDual":
    case "pacedBiv":
    case "av3":
    case "wpw":
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
    // T/ST are myocardial recovery — not impulse travel along conduction fibers
    if (opts.mark === "T" || opts.mark === "ST" || opts.mark === "TP") {
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

      const envelope = 0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, Math.max(0, f.progress)));
      const len = (0.32 + 0.38 * envelope) * (0.75 + 0.35 * opts.mag);
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
    tmpLate.set(0, 0, 0);
    tmpOrigin.set(0, 0, 0);
    let nActive = 0;
    let nLate = 0;

    // Mean from pathway fronts only while depolarizing — T/ST is myocardial recovery
    const useFrontMean =
      meanGroup.visible && !!opts.fronts?.length && !isRepol && opts.mark !== "TP";
    if (useFrontMean) {
      for (const f of opts.fronts!) {
        let dir = new THREE.Vector3(...f.dir);
        if (dir.lengthSq() < 1e-8) continue;
        dir.normalize();
        const envelope = Math.sin(Math.PI * Math.min(1, Math.max(0, f.progress)));
        const w = 0.35 + 0.65 * envelope;
        tmpSum.addScaledVector(dir, w);
        tmpOrigin.addScaledVector(new THREE.Vector3(...f.pos), w);
        nActive += w;
        if (f.id === "rbb" || f.id === "purkinjeR") {
          tmpLate.addScaledVector(dir, w);
          nLate += w;
        }
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
      if (opts.mark === "P" || (opts.mark === "PR" && opts.finding !== "wpw")) {
        chamberOk = s.tissue === "atrial" || s.nearestId === "av" || s.nearestId === "his";
      } else if (opts.mark === "QRS" || opts.mark === "ST" || opts.mark === "T") {
        chamberOk =
          s.tissue === "ventricular" ||
          s.nearestId === "his" ||
          s.nearestId === "accessory" ||
          opts.finding === "av3" ||
          opts.finding === "av3Junctional";
      } else if (opts.mark === "TP") {
        chamberOk = false;
      }
      if (opts.finding === "wpw" && opts.mark === "PR" && s.nearestId === "accessory") {
        chamberOk = true;
      }
      if (opts.finding === "vt" || opts.finding === "pvc") {
        chamberOk = s.tissue === "ventricular";
      }

      const show =
        chamberOk &&
        groupOk &&
        (onFront || justPassed || approaching || (pathwayLive && Math.abs(dist) < 0.12));

      // Direction: depol along pathway travel.
      // T/ST: normal (concordant) keeps QRS-like polarity; discordant findings reverse.
      let dir = s.dir.clone();
      if (lmLive?.reverse) dir.negate();
      if (flipRepol) dir.negate();

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

      // Accumulate instantaneous resultant for mean vector (fallback if no pathway mean)
      if (!useFrontMean && show && intensity > 0.15 && chamberOk) {
        const w = intensity * intensity;
        tmpSum.addScaledVector(dir, w);
        tmpOrigin.addScaledVector(s.pos, w);
        nActive += w;

        // Late forces (right / terminal)
        if (
          (s.nearestId === "rbb" || s.nearestId === "purkinjeR" || s.pos.x < -0.15) &&
          (opts.mark === "QRS" || opts.finding === "rbbb")
        ) {
          tmpLate.addScaledVector(dir, w);
          nLate += w;
        }
      }
    }

    // Mean instantaneous cardiac vector — rotates with the EKG / wavefront
    if (meanGroup.visible) {
      if (nActive > 0.01 && opts.mark !== "TP") {
        const dir = tmpSum.normalize();
        const origin = tmpOrigin.multiplyScalar(1 / nActive);
        // Keep origin near heart center with mild bias toward active mass
        origin.lerp(new THREE.Vector3(0.02, -0.2, 0.05), 0.55);

        const baseLen =
          opts.mark === "QRS" ? 1.05 : opts.mark === "P" ? 0.65 : opts.mark === "T" ? 0.7 : 0.45;
        const len = baseLen * mag * (opts.fronts?.length ? 0.85 : 1);

        meanArrow.visible = true;
        meanArrow.position.copy(origin);
        meanArrow.setDirection(dir);
        meanArrow.setLength(len, len * 0.2, len * 0.12);
        meanArrow.setColor(
          opts.mark === "P" || opts.mark === "PR"
            ? 0xf0c040
            : opts.mark === "T"
              ? 0x8eb0ff
              : opts.mark === "ST"
                ? 0x6ec896
                : 0x3db8c8,
        );
        const lm = meanArrow.line.material;
        if (lm instanceof THREE.LineBasicMaterial) lm.opacity = 0.55 + 0.4 * Math.min(1, mag);

        wavefront.visible = true;
        wavefront.position.copy(origin);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
        wavefront.quaternion.copy(q);
        wavefront.scale.setScalar(0.7 + 0.5 * mag);
        waveMat.color.setHex(
          opts.mark === "P" ? 0xf0c040 : opts.mark === "T" ? 0x8eb0ff : 0x88f0c0,
        );
        waveMat.opacity = 0.2 + 0.25 * Math.min(1, mag);
      } else {
        meanArrow.visible = false;
        wavefront.visible = false;
      }

      // Terminal / late vector (RBBB, injury)
      if (
        nLate > 0.05 &&
        (opts.finding === "rbbb" || opts.mark === "QRS") &&
        opts.mark !== "TP" &&
        opts.mark !== "P"
      ) {
        const dir = tmpLate.normalize();
        lateArrow.visible = true;
        lateArrow.position.set(-0.15, -0.45, 0.2);
        lateArrow.setDirection(dir);
        const len = 0.65 * mag;
        lateArrow.setLength(len, len * 0.25, len * 0.15);
        lateArrow.setColor(0xc070ff);
      } else if (opts.finding === "stemiAnt" && opts.mark === "ST") {
        lateArrow.visible = true;
        lateArrow.position.set(0.1, -0.2, 0.35);
        lateArrow.setDirection(new THREE.Vector3(0.15, -0.1, 0.95).normalize());
        lateArrow.setLength(0.9 * mag, 0.2, 0.12);
        lateArrow.setColor(0x6ec896);
      } else {
        lateArrow.visible = false;
      }
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
      lateArrow.visible = false;
      wavefront.visible = false;
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
    },
    setFieldVisible: (v: boolean) => {
      fieldGroup.visible = v;
    },
    update,
  };
}
