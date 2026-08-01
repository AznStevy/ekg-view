import * as THREE from "three";
import type { CycleMark, LeadId } from "./ekgWaveforms";
import type { FindingId, SegmentId } from "./findings";
import {
  FIELD_ELLIPSOID,
  SEPTUM_WALL,
  AV_JUNCTION,
  inSeptum,
  projectOntoMyocardialShell,
  projectOntoSeptum,
  projectOntoShellTangent,
  ellipsoidNormal,
  ellipsoidNorm2,
  myocardialTravelDistance,
  clampDirToAvPlane,
  septumCoords,
  nearHisPenetration,
} from "./heartEllipsoid";
import {
  activationSeedKey,
  buildActivationGraph,
  buildActivationMap,
  transmuralRepolDir,
  transmuralDepolBias,
  type ActivationGraph,
  type ActivationMapResult,
  type ActivationSeed,
} from "./activationMap";
import { fitCardiacVector } from "./leadAxes";
import type { ActiveFront, BranchWindow, PathwayProbePoint } from "./pathwayTiming";
import {
  branchesForFinding,
  groupsForMark,
  PURKINJE_L_LAF_CURVES,
  PURKINJE_L_LPF_CURVES,
} from "./pathwayTiming";

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
  /** Myocardium vs His/LBAP conduction-tissue capture */
  capture?: "myocardium" | "conduction";
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
  /** QRS width from earliest→latest ventricular LAT (seconds) */
  getQrsDurationSec: (cycleSec: number) => number;
  getQrsFrac: () => number;
  update: (opts: {
    mark: CycleMark;
    active: SegmentId[];
    finding: FindingId;
    tCycle: number;
    /** Cycle length in seconds — used for physiologic arrow lag (~40 ms) */
    cycleSec?: number;
    /** Optional lead voltages for magnitude coupling to the EKG */
    leads?: Partial<Record<LeadId, number>>;
    /** Stim / custom schedule — same windows as impulse animation */
    branches?: BranchWindow[];
    /** Per-branch impulse fronts with travel direction */
    fronts?: ActiveFront[];
    /** Field-first ectopic / paced myocardial capture (one or many pace leads) */
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
  /** Distance to nearest conduction pathway probe */
  pathDist: number;
  /** Depolarization arrival time (NSR-baked; remapped live) */
  actTime: number;
  /** Local wavefront direction arrow */
  arrow: THREE.ArrowHelper;
  /** Activation ball — lit on conduction tissue while depolarized */
  ball: THREE.Mesh;
  /** Soft residual so the field fades instead of blinking off */
  glow: number;
  /** 0 = pathway color, 1 = ectopy/focus color — smoothed handoff */
  pvcBlend: number;
  /** Smoothed display color (avoids orange ↔ blue/green snaps) */
  colorSmooth: THREE.Color;
};

/** Physiologic lag: local vector arrow follows depolarization by ~40 ms. */
/** Field arrows lag myocardial LAT so conduction-system balls lead the vector wave. */
const ARROW_AFTER_DEPOL_SEC = 0.065;

const FIELD_REPOL_GREY = 0x9aa4ae;

const SEGMENT_FIELD_COLOR: Partial<Record<SegmentId, number>> = {
  sa: 0xf0c040,
  internodal: 0xe8a838,
  flutter: 0x8a9aa8,
  av: 0xff7a4a,
  avnrtSlow: 0x9aa4ae,
  avnrtFast: 0xb0b8c0,
  his: 0xff5e6c,
  rbb: 0x5ec8ff,
  lbb: 0x6ae0a8,
  lbba: 0x4ec890,
  lbbp: 0x3ab078,
  purkinjeR: 0x7ad4ff,
  purkinjeL: 0x88f0c0,
  accessory: 0xc070ff,
  accessoryR: 0xa060e8,
  myocardiumA: 0xd08090,
  myocardiumV: 0xc06070,
};

/** Soft rise + long decay — field magnitude fades out instead of snapping off. */
function fieldEnvelope(age: number, rise: number, decay: number): number {
  if (!(age > -rise) || age > decay * 4) return 0;
  if (age < 0) {
    const x = Math.max(0, 1 + age / Math.max(1e-4, rise));
    return x * x;
  }
  return Math.exp(-age / Math.max(0.035, decay));
}

/**
 * Age since an activation event. Multi-beat strips must NOT wrap large positive
 * ages into the next-cycle rise window (that caused random ventricular field
 * before atrial signals on PVC/PAC).
 */
function fieldAge(t: number, eventT: number, longCycle: boolean): number {
  let age = t - eventT;
  if (longCycle) {
    if (age < -0.06) return -1;
    return age;
  }
  if (age < -0.5) age += 1;
  if (age > 0.5) age -= 1;
  return age;
}

/** True for atrial myocardium / internodal / flutter / PV-focus colors. */
function isAtrialFieldColor(hex: number): boolean {
  return (
    hex === 0xf0c040 ||
    hex === 0xe8a838 ||
    hex === 0xe040fb ||
    hex === 0xd08090 ||
    hex === 0x8a9aa8 ||
    hex === SEGMENT_FIELD_COLOR.sa ||
    hex === SEGMENT_FIELD_COLOR.internodal ||
    hex === SEGMENT_FIELD_COLOR.flutter ||
    hex === SEGMENT_FIELD_COLOR.myocardiumA
  );
}

/** Orange ectopy-focus field colors (PVC / ventricular pace) — not Kent purple. */
function isEctopyFieldColor(hex: number): boolean {
  return hex === 0xff8844 || hex === 0xffaa66 || hex === 0xff6a3a || hex === 0xe040fb;
}

function isAtrialFrontId(id: SegmentId): boolean {
  return (
    id === "sa" ||
    id === "internodal" ||
    id === "flutter" ||
    id === "myocardiumA" ||
    id === "avnrtSlow" ||
    id === "avnrtFast"
  );
}

/**
 * General AV-plane rule for the teaching field:
 * Atrial sources must not drive myocardium across the fibrous AV plane into the
 * ventricle, except (1) AV-node → His penetration corridor, or (2) near an
 * accessory pathway when Kent is live.
 */
function nearKentAvCross(pos: THREE.Vector3, nearestId: SegmentId): boolean {
  if (nearestId === "accessory" || nearestId === "accessoryR") return true;
  // Lateral AV groove where left/right Kent bundles cross the fibrous plane
  const nearPlane = Math.abs(pos.y - AV_JUNCTION.planeY) < 0.18;
  if (!nearPlane) return false;
  const leftKent = pos.x > 0.42 && Math.abs(pos.z) < 0.28;
  const rightKent = pos.x < -0.38 && pos.z > -0.05 && pos.z < 0.45;
  return leftKent || rightKent;
}

function atrialSourceMayDriveSample(
  pos: THREE.Vector3,
  tissue: FieldSample["tissue"],
  nearestId: SegmentId,
  accessoryLive: boolean,
  avNodeLive: boolean,
): boolean {
  // Stay on the atrial side of the fibrous plane
  if (tissue === "atrial" && pos.y >= AV_JUNCTION.planeY - 0.02) return true;
  // Accessory pathway: atrial field may cross only near the Kent insertion
  if (accessoryLive && nearKentAvCross(pos, nearestId)) return true;
  // AV node activation may engage the node / His gap only (not free-wall ventricle)
  if (
    avNodeLive &&
    (nearestId === "av" || nearestId === "his") &&
    nearHisPenetration(pos, AV_JUNCTION.hisGapR * 2.6)
  ) {
    return true;
  }
  return false;
}

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
 * Relative conduction-fiber caliber → local field strength.
 * Thicker tracts (broad LBB) outweigh the thin cord-like RBB.
 */
function frontMass(id: SegmentId): number {
  switch (id) {
    case "sa":
      return 1.25;
    case "internodal":
    case "flutter":
      return 1.35;
    case "av":
    case "avnrtSlow":
    case "avnrtFast":
      return 0.95;
    case "his":
      // Compact but substantial penetrating bundle
      return 1.2;
    case "lbb":
      // Broad left bundle — strongest ventricular conduction mass
      return 1.65;
    case "lbbp":
      // Posterior fascicle thicker than anterior
      return 1.32;
    case "lbba":
      return 1.12;
    case "purkinjeL":
      // Dense LV Purkinje network
      return 1.55;
    case "rbb":
      // Thin cord-like right bundle
      return 0.68;
    case "purkinjeR":
      // Sparser RV Purkinje — keep below LV so green/blue stay roughly even
      return 0.7;
    case "accessory":
    case "accessoryR":
      return 1.45;
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

  /** Pathway-following arrows (His red, bundles, Purkinje) — Vectors button only. */
  const pathwayGroup = new THREE.Group();
  pathwayGroup.name = "pathwayVectors";
  pathwayGroup.visible = false;

  const meanArrow = makeArrow(0xf0c040, 1.35);
  meanGroup.add(meanArrow);
  /** Fixed teaching origin for the mathematical resultant — model center. */
  const RESULTANT_ORIGIN = FIELD_ELLIPSOID.center.clone();

  /** One arrow per currently activating anatomic curve (matches impulse pulse fronts). */
  const BRANCH_ARROW_POOL = 96;
  const branchArrows: THREE.ArrowHelper[] = [];
  for (let i = 0; i < BRANCH_ARROW_POOL; i++) {
    const a = makeArrow(0x3db8c8, 0.4);
    a.visible = false;
    branchArrows.push(a);
    pathwayGroup.add(a);
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
      // Kent tracts stay out of resting nearest-bind — otherwise atria light purple in NSR.
      if (id === "accessory" || id === "accessoryR") continue;
      if (tissue === "atrial") {
        // Yellow atrial myocardium field — SA / internodal only (not His/AV red–orange)
        if (id !== "sa" && id !== "internodal" && id !== "flutter" && id !== "myocardiumA") continue;
      } else {
        const atrialSeg =
          id === "sa" ||
          id === "internodal" ||
          id === "flutter" ||
          id === "av" ||
          id === "avnrtSlow" ||
          id === "avnrtFast" ||
          id === "myocardiumA";
        if (atrialSeg) continue;
      }
      const d = pos.distanceToSquared(probePos[i]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { idx: best, dist: Math.sqrt(bestD) };
  }

  const minSep2 = 0.055 * 0.055;
  const pushFieldSample = (x: number, y: number, z: number) => {
    const septal = inSeptum([x, y, z]);
    const n2 = ellipsoidNorm2([x, y, z]);
    const inShell = n2 >= FIELD_ELLIPSOID.innerLimit && n2 <= FIELD_ELLIPSOID.outerLimit;
    if (!septal && !inShell) return;

    const inInsulator =
      !septal &&
      Math.abs(y - AV_JUNCTION.planeY) < 0.07 &&
      Math.hypot(x - AV_JUNCTION.hisGap.x, z - AV_JUNCTION.hisGap.z) > AV_JUNCTION.hisGapR;
    const tissue: FieldSample["tissue"] = inInsulator
      ? "insulator"
      : y <= AV_JUNCTION.planeY
        ? "ventricular"
        : "atrial";

    const probe = new THREE.Vector3(x, y, z);
    for (const s of samples) {
      if (s.pos.distanceToSquared(probe) < minSep2) return;
    }

    const pos = probe;
    const arrow = makeArrow(0x3db8c8, 0.14);
    arrow.visible = false;
    fieldGroup.add(arrow);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.028, 8, 6),
      new THREE.MeshBasicMaterial({
        color: 0x88f0c0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    ball.visible = false;
    ball.position.copy(pos);
    fieldGroup.add(ball);

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
        pathDist: 99,
        actTime: 99,
        arrow,
        ball,
        glow: 0,
        pvcBlend: 0,
        colorSmooth: new THREE.Color(0x9aa4ae),
      });
      return;
    }

    const { idx, dist } = nearestProbe(pos, tissue === "atrial" ? "atrial" : "ventricular");
    const pr = probes[idx]!;
    const tangent = probeTan[idx]!.clone();
    const outward = pos.clone().sub(probePos[idx]!);
    if (outward.lengthSq() > 1e-8) outward.normalize();
    else outward.set(0, 0, 0);
    const dir = tangent.clone().multiplyScalar(0.72).add(outward.multiplyScalar(0.28));
    if (dir.lengthSq() < 1e-6) dir.copy(tangent);
    else dir.normalize();
    projectOntoShellTangent(dir, pos);

    const pathTime = pr.enterT + (pr.exitT - pr.enterT) * pr.pathU;
    samples.push({
      pos,
      tissue,
      nearestId: pr.segmentId,
      nearestColor: pr.color,
      dir,
      dirSmooth: dir.clone(),
      pathU: pr.pathU,
      pathDist: dist,
      actTime: pathTime + dist * 0.42,
      arrow,
      ball,
      glow: 0,
      pvcBlend: 0,
      colorSmooth: new THREE.Color(pr.color),
    });
  };

  // Free-wall shell: angular lattice on the ellipsoid at several wall depths
  {
    const { center, radius, innerLimit, outerLimit } = FIELD_ELLIPSOID;
    const depthFracs = [0.18, 0.5, 0.82];
    const nLat = 14;
    for (let iLat = 0; iLat < nLat; iLat++) {
      const lat = -Math.PI * 0.5 + ((iLat + 0.5) / nLat) * Math.PI;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const nLon = Math.max(8, Math.round(10 + 14 * Math.abs(cosLat)));
      for (let iLon = 0; iLon < nLon; iLon++) {
        const lon = ((iLon + 0.5) / nLon) * Math.PI * 2;
        const ux = cosLat * Math.cos(lon);
        const uy = sinLat;
        const uz = cosLat * Math.sin(lon);
        for (const df of depthFracs) {
          const n2 = innerLimit + df * (outerLimit - innerLimit);
          const s = Math.sqrt(n2);
          const x = ux * s * radius.x;
          const y = center.y + uy * s * radius.y;
          const z = uz * s * radius.z;
          if (inSeptum([x, y, z])) continue;
          pushFieldSample(x, y, z);
        }
      }
    }
    // Extra LV free-wall samples — left Purkinje anatomy is sparse rays; densify the
    // green field territory so it reads filled through late QRS (not tip speckles).
    const nLatL = 12;
    for (let iLat = 0; iLat < nLatL; iLat++) {
      const lat = -Math.PI * 0.45 + ((iLat + 0.5) / nLatL) * Math.PI * 0.85;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const nLon = Math.max(7, Math.round(9 + 12 * Math.abs(cosLat)));
      for (let iLon = 0; iLon < nLon; iLon++) {
        // +x hemisphere only (LV)
        const lon = -Math.PI * 0.48 + ((iLon + 0.5) / nLon) * Math.PI * 0.96;
        const ux = cosLat * Math.cos(lon);
        if (ux < 0.08) continue;
        const uy = sinLat;
        const uz = cosLat * Math.sin(lon);
        for (const df of [0.22, 0.48, 0.72]) {
          const n2 = innerLimit + df * (outerLimit - innerLimit);
          const s = Math.sqrt(n2);
          const x = ux * s * radius.x;
          const y = center.y + uy * s * radius.y;
          const z = uz * s * radius.z;
          if (inSeptum([x, y, z])) continue;
          pushFieldSample(x, y, z);
        }
      }
    }
  }

  // Septum: polar rings in the hourglass plane (wraps rim + faces)
  {
    const { center, normal, longAxis, shortAxis } = SEPTUM_WALL;
    const faces: Array<-1 | 0 | 1> = [-1, 0, 1];
    const nRho = 7;
    for (let ir = 0; ir < nRho; ir++) {
      const rho = 0.08 + (ir / Math.max(1, nRho - 1)) * 0.82;
      const nAng = Math.max(8, Math.round(8 + 16 * rho));
      for (let ia = 0; ia < nAng; ia++) {
        const ang = ((ia + 0.5) / nAng) * Math.PI * 2;
        const cu = Math.cos(ang);
        const sv = Math.sin(ang);
        const seed = new THREE.Vector3()
          .copy(center)
          .addScaledVector(longAxis, cu * rho * 0.7)
          .addScaledVector(shortAxis, sv * rho * 0.7);
        for (const face of faces) {
          if (rho > 0.72 && face === 0) continue;
          if (rho < 0.2 && face !== 0 && ir % 2 === 1) continue;
          const [x, y, z] = projectOntoSeptum([seed.x, seed.y, seed.z], face);
          if (!inSeptum([x, y, z])) continue;
          pushFieldSample(x, y, z);
        }
      }
    }
    // Rim annulus + shell neighbors so septum↔free-wall flow is continuous
    for (let ia = 0; ia < 20; ia++) {
      const ang = ((ia + 0.5) / 20) * Math.PI * 2;
      const seed = new THREE.Vector3()
        .copy(center)
        .addScaledVector(longAxis, Math.cos(ang) * 0.85)
        .addScaledVector(shortAxis, Math.sin(ang) * 0.85);
      for (const face of [-1, 1] as const) {
        const [x, y, z] = projectOntoSeptum([seed.x, seed.y, seed.z], face);
        pushFieldSample(x, y, z);
      }
      const [sx, sy, sz] = projectOntoMyocardialShell([
        seed.x + normal.x * 0.12,
        seed.y + normal.y * 0.12,
        seed.z + normal.z * 0.12,
      ]);
      if (!inSeptum([sx, sy, sz])) pushFieldSample(sx, sy, sz);
    }
  }

  // AV fibrous groove: ring on the shell at the AV plane (insulator + basal vestibule)
  {
    const { center, radius, innerLimit, outerLimit } = FIELD_ELLIPSOID;
    const py = AV_JUNCTION.planeY;
    for (let i = 0; i < 36; i++) {
      const ang = ((i + 0.5) / 36) * Math.PI * 2;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      for (const df of [0.28, 0.55, 0.82]) {
        const n2 = innerLimit + df * (outerLimit - innerLimit);
        const s = Math.sqrt(n2);
        let uy = (py - center.y) / (s * radius.y);
        if (Math.abs(uy) > 0.92) continue;
        const horiz = Math.sqrt(Math.max(0, 1 - uy * uy));
        const x = ux * horiz * s * radius.x;
        const y = py;
        const z = uz * horiz * s * radius.z;
        if (inSeptum([x, y, z])) continue;
        pushFieldSample(x, y, z);
        // Ventricular basal ring just inferior to the plane
        const [vx, vy, vz] = projectOntoMyocardialShell([x, py - 0.1, z]);
        if (vy <= py - 0.02) pushFieldSample(vx, vy, vz);
        // Atrial basal ring just superior
        const [ax, ay, az] = projectOntoMyocardialShell([x, py + 0.1, z]);
        if (ay >= py + 0.02) pushFieldSample(ax, ay, az);
      }
    }
    // Extra atrial samples near LA / pulmonary veins so AFib pink wavefronts have
    // field arrows to travel across (posterior-superior left atrium).
    for (let iLat = 0; iLat < 8; iLat++) {
      const lat = Math.PI * 0.08 + ((iLat + 0.5) / 8) * Math.PI * 0.42;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const nLon = 10;
      for (let iLon = 0; iLon < nLon; iLon++) {
        const lon = -Math.PI * 0.15 + ((iLon + 0.5) / nLon) * Math.PI * 0.85;
        const ux = cosLat * Math.cos(lon);
        const uy = sinLat;
        const uz = cosLat * Math.sin(lon);
        if (ux < 0.05 || uy < 0.05) continue;
        for (const df of [0.35, 0.62, 0.85]) {
          const n2 = innerLimit + df * (outerLimit - innerLimit);
          const s = Math.sqrt(n2);
          const x = ux * s * radius.x;
          const y = center.y + uy * s * radius.y;
          const z = uz * s * radius.z;
          if (y < AV_JUNCTION.planeY + 0.03) continue;
          if (inSeptum([x, y, z])) continue;
          pushFieldSample(x, y, z);
        }
      }
    }
    // Extra RA samples around the CTI / tricuspid annulus so flutter grey loop
    // has a continuous field shell (lateral → medial isthmus → septum → roof).
    for (let i = 0; i < 28; i++) {
      const u = (i + 0.5) / 28;
      const ang = -0.35 + u * (Math.PI * 1.55);
      const ux = -Math.abs(Math.cos(ang));
      const uz = Math.sin(ang) * 0.85;
      const uy = 0.08 + 0.55 * Math.sin(u * Math.PI);
      for (const df of [0.4, 0.68, 0.9]) {
        const n2 = innerLimit + df * (outerLimit - innerLimit);
        const s = Math.sqrt(n2);
        const horiz = Math.sqrt(Math.max(0, 1 - uy * uy * 0.35));
        const x = ux * horiz * s * radius.x * 0.92;
        const y = center.y + uy * s * radius.y;
        const z = uz * horiz * s * radius.z;
        if (y < AV_JUNCTION.planeY - 0.02) continue;
        if (x > 0.12) continue;
        if (inSeptum([x, y, z])) continue;
        pushFieldSample(x, y, z);
      }
    }
  }

  root.add(meanGroup, pathwayGroup, fieldGroup);

  const sampleInputs = samples.map((s) => ({ pos: s.pos, tissue: s.tissue }));
  const activationGraph: ActivationGraph = buildActivationGraph(sampleInputs);
  let cachedMapKey = "";
  let cachedActMap: ActivationMapResult | null = null;

  const tmpSum = new THREE.Vector3();
  const tmpOrigin = new THREE.Vector3();
  const tmpToFront = new THREE.Vector3();
  const tmpOutward = new THREE.Vector3();
  const tmpPathDir = new THREE.Vector3();
  const tmpFieldAcc = new THREE.Vector3();
  const tmpContribDir = new THREE.Vector3();
  /** Smoothed resultant — direction/strength track the EKG dipole; origin tracks the front. */
  const smoothMeanDir = new THREE.Vector3(0.45, -0.72, 0.22).normalize();
  const smoothMeanOrigin = RESULTANT_ORIGIN.clone();
  let smoothMeanStrength = 0;
  let smoothMeanReady = false;
  let smoothMeanColor = new THREE.Color(0xf0c040);
  let smoothWaveColor = new THREE.Color(0xf0c040);
  const tmpWaveColor = new THREE.Color();
  const tmpEctopyColor = new THREE.Color();
  /** Latest ventricular LAT span (cycle fraction) from activation map */
  let lastQrsFrac = 0.12;

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
 * Normal myocardium: recovery follows activation order → T roughly concordant.
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
    case "pacedRvSeptal":
    case "pacedRvot":
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

/** ECG-effective recovery polarity vs local depolarization direction — unused for field physics. */
function _repolFlipsDepolUnused(finding: FindingId, mark: CycleMark): boolean {
  return (mark === "T" || mark === "ST") && isDiscordantRepol(finding);
}
void _repolFlipsDepolUnused;

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
      const frontPos = new THREE.Vector3(...f.pos);
      // His/AV pathway vectors: never point up across the fibrous AV plane
      if (f.id === "his" || f.id === "av") {
        clampDirToAvPlane(frontPos, dir, true);
        if (frontPos.y > AV_JUNCTION.planeY + 0.02 && dir.y > 0) {
          dir.y = 0;
          if (dir.lengthSq() < 1e-10) dir.set(0, -1, 0);
          else dir.normalize();
        }
      }

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
      // Hide His/AV branch tips that sit above the AV plane pointing/straying atrially
      if (
        (f.id === "his" || f.id === "av") &&
        frontPos.y > AV_JUNCTION.planeY + 0.02
      ) {
        arrow.visible = false;
        continue;
      }
      arrow.visible = true;
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
    cycleSec?: number;
    leads?: Partial<Record<LeadId, number>>;
    branches?: BranchWindow[];
    fronts?: ActiveFront[];
    ectopyFocus?: MyocardialFocusOpts | MyocardialFocusOpts[] | null;
    preExcitation?: PreExcitationOpts | null;
    lesionIds?: SegmentId[];
  }) {
    const t = ((opts.tCycle % 1) + 1) % 1;
    const cycleSec = Math.max(0.25, opts.cycleSec ?? 0.86);
    const arrowDelayFrac = ARROW_AFTER_DEPOL_SEC / cycleSec;
    const branches = opts.branches ?? branchesForFinding(opts.finding);
    const lesions = new Set(opts.lesionIds ?? []);
    const liveSegments = new Set<SegmentId>();
    const liveGroups = new Set(groupsForMark(opts.mark));
    for (const b of branches) {
      if (t >= b.t0 && t <= b.t1 && !lesions.has(b.id)) liveSegments.add(b.id);
    }
    // Also trust EKG active set — but never re-light lesioned tracts
    for (const id of opts.active) {
      if (!lesions.has(id)) liveSegments.add(id);
    }
    const isAfib = opts.finding === "afib";
    const isFlutter = opts.finding === "aflutterCcw" || opts.finding === "aflutterCw";
    const isAvrt =
      opts.finding === "avrtOrthoLeft" ||
      opts.finding === "avrtOrthoRight" ||
      opts.finding === "avrtAntiLeft" ||
      opts.finding === "avrtAntiRight";
    const longCycle = (opts.cycleSec ?? 1) > 1.6;
    // AFib f-waves / CTI flutter never idle — keep atrial group eligible under every EKG mark
    if (isAfib || isFlutter) {
      liveGroups.add("atrial");
      liveSegments.add("internodal");
      liveSegments.add("myocardiumA");
      if (isFlutter) liveSegments.add("flutter");
    }

    // Accessory pathway live → atrial field may cross the AV plane (Kent)
    const accessoryLive =
      liveSegments.has("accessory") ||
      liveSegments.has("accessoryR") ||
      opts.finding === "avrtAntiLeft" ||
      opts.finding === "avrtAntiRight" ||
      opts.finding === "avrtOrthoLeft" ||
      opts.finding === "avrtOrthoRight" ||
      !!opts.preExcitation;
    // AV node / His activating → field may enter the penetration corridor only
    const avNodeLive =
      liveSegments.has("av") ||
      liveSegments.has("his") ||
      opts.mark === "PR" ||
      (opts.mark === "QRS" && (opts.active.includes("av") || opts.active.includes("his")));

    // Precompute live fronts for spreading field shells (all rhythms)
    const fieldFronts: {
      pos: THREE.Vector3;
      dir: THREE.Vector3;
      id: SegmentId;
      color: number;
      atrial: boolean;
      progress: number;
    }[] = [];
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
        color: f.color || SEGMENT_FIELD_COLOR[f.id] || 0x889098,
        atrial,
        progress: f.progress,
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

    // lesions already computed above for liveSegments gating
    // LAT map + myocardial Dijkstra handle delay into blocked territory — no additive lag
    const isRepol = opts.mark === "T" || opts.mark === "ST";
    /** Field arrows: transparent grey epi→endo on the T wave — keep depol through QRS+ST. */
    const fieldRepol = opts.mark === "T";
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
      capture: "myocardium" | "conduction";
      since: number;
      waveActive: boolean;
      firing: boolean;
    };
    const liveFoci: LiveFocus[] = foci.map((f) => {
      const since = fieldAge(t, f.t0 ?? 0.22, longCycle);
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
        capture: f.capture ?? "myocardium",
        since,
        waveActive: since >= -0.02 && since <= waveDur,
        firing: since >= -0.01 && since <= fireDur,
      };
    });
    // AFib: one PV ostium emits repeating wavefronts that travel across the atria.
    // Marker pulses each burst; field uses multi-burst travel (see focus loop).
    const AFIB_PV_PERIOD = 0.13;
    if (isAfib && liveFoci.length === 1 && liveFoci[0]!.tissue === "atrial") {
      const f = liveFoci[0]!;
      const phase = ((t % AFIB_PV_PERIOD) + AFIB_PV_PERIOD) % AFIB_PV_PERIOD;
      f.since = phase;
      f.t0 = t - phase;
      f.waveActive = true; // f-waves never idle
      f.firing = phase <= f.fireDur;
      f.speed = 0.4;
      f.waveDur = 0.55;
    }

    // Pathway conduction arrows (incl. red His) only with Vectors — not Field alone
    pathwayGroup.visible = meanGroup.visible;
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

    // One focus marker per pace lead / ectopy site.
    // AVRT: no focus orb — field rides the Kent tube only.
    for (let i = 0; i < FOCUS_POOL; i++) {
      const marker = focusMarkers[i]!;
      const ring = focusRings[i]!;
      const focus = liveFoci[i];
      const show =
        fieldGroup.visible &&
        !isAvrt &&
        ((focus && !preExLive) || (i === 0 && preExLive && !!preExPos));
      marker.visible = !!show;
      ring.visible = !!show;
      if (!show) continue;

      const raw = preExLive && preExPos && i === 0 ? preExPos : focus!.pos;
      const rawArr: [number, number, number] = [raw.x, raw.y, raw.z];
      const septalFocus =
        inSeptum(rawArr) || ellipsoidNorm2(rawArr) < FIELD_ELLIPSOID.innerLimit * 1.12;
      let fp: THREE.Vector3;
      let n: THREE.Vector3;
      if (septalFocus) {
        const { n: planeN } = septumCoords(rawArr);
        const face: -1 | 1 = planeN >= 0 ? 1 : -1;
        fp = new THREE.Vector3(...projectOntoSeptum(rawArr, face));
        n = SEPTUM_WALL.normal.clone().multiplyScalar(face);
        fp.addScaledVector(n, 0.02);
      } else {
        fp = new THREE.Vector3(...projectOntoMyocardialShell(rawArr));
        n = ellipsoidNormal(fp);
        fp.addScaledVector(n, 0.028);
      }
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

    // —— Activation map seeds along conduction (ventricular HPS) ——
    // Blocked tracts never seed. Complete BBB: only distal free-wall Purkinje of the
    // intact chamber (septal twigs near midline expand into both sides → look "even").
    const mapSeeds: ActivationSeed[] = [];
    const lafOnly = lesions.has("lbba") && !lesions.has("lbbp") && !lesions.has("lbb");
    const lpfOnly = lesions.has("lbbp") && !lesions.has("lbba") && !lesions.has("lbb");
    const leftComplete =
      lesions.has("lbb") ||
      lesions.has("purkinjeL") ||
      (lesions.has("lbba") && lesions.has("lbbp"));
    const rightComplete = lesions.has("rbb") || lesions.has("purkinjeR");
    const blockedChamber: "left" | "right" | null = leftComplete
      ? "left"
      : rightComplete
        ? "right"
        : null;
    const blockedFascicle: "laf" | "lpf" | null = lafOnly ? "laf" : lpfOnly ? "lpf" : null;

    for (let pi = 0; pi < probes.length; pi++) {
      const pr = probes[pi]!;
      const id = pr.segmentId;
      const isHis = id === "his";
      const isLeft =
        id === "lbb" || id === "lbba" || id === "lbbp" || id === "purkinjeL";
      const isBundle = id === "rbb" || id === "lbb" || id === "lbba" || id === "lbbp";
      const isPurk = id === "purkinjeL" || id === "purkinjeR";
      if (!isHis && !isBundle && !isPurk) continue;
      if (lesions.has(id)) continue;
      // Left HPS: every probe (LV needs dense green seeds).
      // Right Purkinje: subsample harder so blue doesn't outnumber green.
      if (id === "purkinjeR" && pi % 3 !== 0) continue;
      if (!isLeft && id !== "purkinjeR" && pi % 2 !== 0) continue;
      const ci = pr.curveIndex ?? 0;

      if (leftComplete && rightComplete) continue; // trifascicular — ectopy only

      // Field colors = conduction-branch origin. Balls race the HPS first; field seeds
      // fire slightly after the tip so arrows trail in that branch's color.
      const allowHisSeed =
        isHis &&
        pr.pos[1]! <= AV_JUNCTION.planeY + 0.02 &&
        pr.pathU >= 0.35 &&
        pr.pathU <= 0.95;

      if (leftComplete) {
        // LBBB: His (red septum only) + right Purkinje (blue myocardial fill)
        if (allowHisSeed) {
          /* keep */
        } else if (id === "rbb" && pr.pathU >= 0.45 && pr.pathU <= 0.85 && pr.pos[0]! < -0.05) {
          /* distal RBB — same blue family as right Purkinje */
        } else if (id !== "purkinjeR" || pr.pos[0]! > -0.28 || pr.pathU < 0.55) {
          continue;
        }
      } else if (rightComplete) {
        // RBBB: His + left conducting fascicle / Purkinje (dense green → RV fill)
        if (allowHisSeed) {
          /* keep */
        } else if (id === "lbb" && !lafOnly && !lpfOnly && pr.pathU >= 0.25 && pr.pathU <= 0.92) {
          /* keep main LBB */
        } else if (id === "lbba" && !lpfOnly && !lesions.has("lbba") && pr.pathU >= 0.28) {
          /* keep */
        } else if (id === "lbbp" && !lafOnly && !lesions.has("lbbp") && pr.pathU >= 0.28) {
          /* keep */
        } else if (id !== "purkinjeL") {
          continue;
        } else {
          if (lafOnly && PURKINJE_L_LAF_CURVES.has(ci)) continue;
          if (lpfOnly && PURKINJE_L_LPF_CURVES.has(ci)) continue;
          if (pr.pos[0]! < 0.12 || pr.pathU < 0.28) continue;
        }
      } else {
        // NSR / fascicular: His + intact left network (green) + right Purkinje (blue)
        if (allowHisSeed) {
          /* keep */
        } else if (isBundle) {
          if (id === "lbba" && (lafOnly || lesions.has("lbba"))) continue;
          if (id === "lbbp" && (lpfOnly || lesions.has("lbbp"))) continue;
          if (lesions.has(id)) continue;
          // Left fascicles/LBB seed earlier along the tract so LV greens fill the wall
          const lo = isLeft ? 0.22 : 0.4;
          const hi = isLeft ? 0.95 : 0.9;
          if (pr.pathU < lo || pr.pathU > hi) continue;
        } else if (!isPurk) {
          continue;
        } else {
          if (id === "purkinjeL") {
            if (lafOnly && PURKINJE_L_LAF_CURVES.has(ci)) continue;
            if (lpfOnly && PURKINJE_L_LPF_CURVES.has(ci)) continue;
            // Seed along the ray so green fills mid → lateral LV, not tip speckles
            if (pr.pathU < 0.22) continue;
          } else if (pr.pathU < 0.55) {
            continue;
          }
        }
      }

      const meta = liveMeta.get(id) ?? branchMeta.get(id);
      if (!meta) continue;
      const span = Math.max(0.01, meta.t1 - meta.t0);
      // Tip lag: balls lead arrows. Slightly earlier left seeds so LV greens claim
      // their wall first in NSR — without hard chamber walls that break BBB fill.
      const tipLag = isLeft ? 0.006 : 0.022;
      mapSeeds.push({
        pos: pr.pos,
        t0: meta.t0 + pr.pathU * span + tipLag,
        segmentId: id,
        capture: "conduction",
        color: pr.color,
      });
    }
    // Pace / ectopy foci seed the LAT map. Atrial foci stay atrial-only.
    // AFib PV bursts are shell-driven (t0 wobbles) — never seed the vent map with pink.
    // Only seed while the wave is live — stale PVC seeds caused ventricles to light
    // before the next sinus P on multi-beat strips.
    for (const focus of liveFoci) {
      if (!focus.waveActive && !(isAfib && focus.tissue === "atrial")) continue;
      if (focus.tissue === "atrial") {
        if (isAfib) continue;
        mapSeeds.push({
          pos: [focus.pos.x, focus.pos.y, focus.pos.z],
          t0: focus.t0,
          segmentId: "myocardiumA",
          color: focus.color,
        });
        continue;
      }
      mapSeeds.push({
        pos: [focus.pos.x, focus.pos.y, focus.pos.z],
        t0: focus.t0,
        capture: focus.capture,
        color: focus.color,
      });
    }
    if (preEx && preExPos) {
      mapSeeds.push({
        pos: [preExPos.x, preExPos.y, preExPos.z],
        t0: preExT0,
        capture: "myocardium",
        color: preExColor,
      });
    }

    // Field myocardial spread is slower than HPS balls so arrows trail in branch color
    const myoSpeed =
      leftComplete || rightComplete ? 0.125 : lesions.size ? 0.105 : 0.095;
    const mapKey = activationSeedKey(
      mapSeeds,
      opts.lesionIds,
      myoSpeed,
      blockedChamber,
      blockedFascicle,
    );
    let actMap = cachedActMap;
    if (!actMap || mapKey !== cachedMapKey) {
      actMap = buildActivationMap({
        samples: sampleInputs,
        seeds: mapSeeds,
        lesionIds: opts.lesionIds,
        myoSpeed,
        blockedChamber,
        blockedFascicle,
        graph: activationGraph,
      });
      cachedActMap = actMap;
      cachedMapKey = mapKey;
    }
    lastQrsFrac = actMap.qrsFrac;

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
        tmpOutward.set(f.dir[0]!, f.dir[1]!, f.dir[2]!);
        if (tmpOutward.lengthSq() < 1e-8) continue;
        tmpOutward.normalize();
        const p = Math.min(1, Math.max(0, f.progress));
        const envelope = p < 0.12 ? p / 0.12 : 1;
        const w = (0.35 + 0.65 * envelope) * frontMass(f.id) * (f.reverse ? 1.35 : 1);
        tmpSum.addScaledVector(tmpOutward, w);
        tmpOrigin.x += f.pos[0]! * w;
        tmpOrigin.y += f.pos[1]! * w;
        tmpOrigin.z += f.pos[2]! * w;
        nActive += w;
        nOrigin += w;
      }
    }

    // Field arrows/balls are the expensive path — skip entirely when field is off.
    // Mean arrow still updates from lead voltages (+ front sum above).
    if (!fieldGroup.visible) {
      for (let si = 0; si < samples.length; si++) {
        const s = samples[si]!;
        if (s.arrow.visible) s.arrow.visible = false;
        if (s.ball.visible) s.ball.visible = false;
        s.glow = 0;
      }
    } else for (let si = 0; si < samples.length; si++) {
      const s = samples[si]!;
      const mapSt = actMap.samples[si]!;
      if (s.tissue === "insulator") {
        s.arrow.visible = true;
        s.arrow.position.copy(s.pos);
        s.arrow.setDirection(tmpOutward.set(0, 1, 0));
        s.arrow.setLength(0.035, 0.018, 0.012);
        s.arrow.setColor(0x9aa4ae);
        const lm = s.arrow.line.material;
        if (lm instanceof THREE.LineBasicMaterial) lm.opacity = 0.16;
        s.ball.visible = false;
        continue;
      }

      // Blocked territory stays dark until myocardial LAT arrives — but do not
      // require an early lead-in (that hid the septal cross in BBB teaching).
      const awaitingBlockFill =
        s.tissue === "ventricular" &&
        !isRepol &&
        ((blockedChamber === "left" && s.pos.x > 0.04) ||
          (blockedChamber === "right" && s.pos.x < -0.04) ||
          (blockedFascicle === "laf" &&
            s.pos.x > 0.12 &&
            s.pos.z > -0.05 &&
            s.pos.y > -1.08) ||
          (blockedFascicle === "lpf" && s.pos.x > 0.1 && s.pos.z < -0.12 && s.pos.y < -0.35));
      if (awaitingBlockFill && mapSt.lat >= 1e8) {
        s.arrow.visible = false;
        s.ball.visible = false;
        s.glow = 0;
        continue;
      }
      if (awaitingBlockFill && t + 0.002 < mapSt.lat) {
        s.arrow.visible = false;
        s.ball.visible = false;
        s.glow = 0;
        continue;
      }

      // Prefer pathway timing for atria; LAT map is ventricular HPS.
      // Blocked tracts never contribute pathway actTime — myocardium fills from intact seeds.
      const blockTerritory =
        lesions.has(s.nearestId) ||
        (leftComplete && !rightComplete && s.pos.x > 0.02) ||
        (rightComplete && !leftComplete && s.pos.x < -0.02) ||
        (lafOnly && (s.nearestId === "lbba" || (s.nearestId === "purkinjeL" && s.pos.z > -0.08 && s.pos.x < 0.55))) ||
        (lpfOnly && (s.nearestId === "lbbp" || (s.nearestId === "purkinjeL" && s.pos.z < -0.15)));

      let act =
        s.tissue === "atrial" || mapSt.lat >= 1e8 ? s.actTime : mapSt.lat;
      const lmLive = blockTerritory ? undefined : liveMeta.get(s.nearestId);
      if (lmLive) {
        const uFrac = lmLive.reverse ? 1 - s.pathU : s.pathU;
        const pathAct = lmLive.t0 + uFrac * (lmLive.t1 - lmLive.t0);
        act = s.tissue === "atrial" ? pathAct : Math.min(act, pathAct);
      }

      // Field-first myocardial capture: expanding shell from each pace / ectopy tip.
      let fromMyoFocus = false;
      let engagedTract = false;
      let focusColor: number | null = null;
      let focusDir: THREE.Vector3 | null = null;
      let focusTissue: "atrial" | "ventricular" | null = null;
      let shellReached = false;
      let anyEctopyWave = false;
      let focusLocalAge = 0;
      for (const focus of liveFoci) {
        // AFib f-waves continue through ST/T; other ectopy pauses on ventricular repol
        if (!focus.waveActive) continue;
        if (isRepol && !(isAfib && focus.tissue === "atrial")) continue;
        const tissueOk = s.tissue === focus.tissue;
        if (!tissueOk) continue;
        // AV plane: atrial sources stay atrial unless AV-node corridor or accessory
        if (
          focus.tissue === "atrial" &&
          !atrialSourceMayDriveSample(s.pos, s.tissue, s.nearestId, accessoryLive, avNodeLive)
        ) {
          continue;
        }
        anyEctopyWave = true;
        const dFocus = myocardialTravelDistance(focus.pos, s.pos);

        if (isAfib && focus.tissue === "atrial") {
          // Repeating PV emissions: sample lights when a wavefront arrives and briefly after.
          // period < wave travel so successive pink fronts sweep the atrial shell.
          const period = 0.13;
          const speed = Math.max(0.28, focus.speed);
          const hold = 0.1;
          let bestAge = Infinity;
          const burst0 = Math.floor(t / period);
          for (let b = 0; b < 5; b++) {
            const emit = (burst0 - b) * period;
            const arrive = emit + dFocus * speed;
            let age = t - arrive;
            if (age < -0.5) age += 1;
            if (age > 0.5) age -= 1;
            if (age >= -0.03 && age <= hold && age < bestAge) bestAge = age;
          }
          if (bestAge < Infinity) {
            shellReached = true;
            fromMyoFocus = true;
            focusTissue = "atrial";
            focusColor = focus.color;
            focusLocalAge = bestAge;
            tmpOutward.copy(s.pos).sub(focus.pos);
            if (tmpOutward.lengthSq() > 1e-8) {
              focusDir = projectOntoShellTangent(tmpOutward, s.pos);
              if (!(accessoryLive && nearKentAvCross(s.pos, s.nearestId))) {
                clampDirToAvPlane(s.pos, focusDir, true);
              }
            }
          }
          continue;
        }

        const fieldAct = focus.t0 + dFocus * focus.speed;
        const radiusNow = Math.max(0, focus.since / Math.max(1e-4, focus.speed));
        // Soft shell edge so the wave expands smoothly then dissipates
        const softEdge = 0.12;
        const reached = dFocus <= radiusNow + softEdge;
        if (reached) shellReached = true;
        const tractReady =
          reached &&
          !!lmLive &&
          t >= lmLive.t0 &&
          (focus.tissue === "ventricular"
            ? lmLive.group === "ectopy" ||
              s.nearestId === "purkinjeL" ||
              s.nearestId === "purkinjeR" ||
              s.nearestId === "rbb" ||
              s.nearestId === "lbb" ||
              s.nearestId === "lbba" ||
              s.nearestId === "lbbp"
            : lmLive.group === "ectopy" ||
              lmLive.group === "atrial" ||
              s.nearestId === "internodal" ||
              s.nearestId === "av" ||
              s.nearestId === "sa");

        if (reached || fieldAct <= t + 0.04) {
          if (!fromMyoFocus || fieldAct < act) {
            act = fieldAct;
            fromMyoFocus = true;
            focusTissue = focus.tissue;
            focusColor = focus.color;
            focusLocalAge = focus.since - dFocus * focus.speed;
            // Travel direction = LAT gradient (wavefront), not starburst radial out
            if (mapSt.depolDir.lengthSq() > 1e-10 && mapSt.lat < 1e8) {
              focusDir = mapSt.depolDir.clone();
              projectOntoShellTangent(focusDir, s.pos);
            } else {
              tmpOutward.copy(s.pos).sub(focus.pos);
              if (tmpOutward.lengthSq() > 1e-8) {
                focusDir = projectOntoShellTangent(tmpOutward, s.pos);
              }
            }
          }
        }
        if (tractReady) engagedTract = true;
      }
      // Antidromic pre-excitation: purple field traveling from Kent ventricular tip
      if (preExLive && preExPos && (s.tissue === "ventricular" || s.nearestId === "accessory" || s.nearestId === "accessoryR") && !isRepol) {
        const dFocus = myocardialTravelDistance(preExPos, s.pos);
        const fieldAct = preExT0 + dFocus * 0.72;
        if (fieldAct <= preExT1 + 0.12 && (!lmLive || fieldAct <= act + 0.04 || s.nearestId === "accessory" || s.nearestId === "accessoryR")) {
          act = Math.min(act, fieldAct);
          fromMyoFocus = true;
          focusTissue = "ventricular";
          focusColor = preExColor;
          focusLocalAge = t - fieldAct;
          shellReached = true;
          if (mapSt.depolDir.lengthSq() > 1e-10 && mapSt.lat < 1e8) {
            focusDir = mapSt.depolDir.clone();
            projectOntoShellTangent(focusDir, s.pos);
          } else {
            tmpOutward.copy(s.pos).sub(preExPos);
            if (tmpOutward.lengthSq() > 1e-8) {
              focusDir = projectOntoShellTangent(tmpOutward, s.pos);
            }
          }
        }
      }

      // Blocked territory activates via myocardial LAT (intact-side seeds) — do not
      // darken nearest-lesion samples or add artificial chamber delays.

      // Repolarization wave follows depol with delay (~ST/T)
      const meta = blockTerritory
        ? undefined
        : liveMeta.get(s.nearestId) ?? branchMeta.get(s.nearestId);
      const groupOk =
        fromMyoFocus ||
        blockTerritory ||
        liveGroups.size === 0 ||
        !meta ||
        liveGroups.has(meta.group) ||
        liveSegments.has(s.nearestId);

      // Chamber gating from EKG mark
      let chamberOk = true;
      if (
        opts.mark === "P" ||
        (opts.mark === "PR" &&
          opts.finding !== "avrtAntiLeft" &&
          opts.finding !== "avrtAntiRight")
      ) {
        // Atrial shell + AV/His only on/below the fibrous plane (no red arrows above it)
        chamberOk =
          s.tissue === "atrial" ||
          ((s.nearestId === "av" || s.nearestId === "his") &&
            s.pos.y <= AV_JUNCTION.planeY + 0.01);
      } else if (opts.mark === "QRS" || opts.mark === "ST" || opts.mark === "T") {
        chamberOk =
          s.tissue === "ventricular" ||
          s.nearestId === "accessory" ||
          s.nearestId === "accessoryR" ||
          opts.finding === "av3" ||
          opts.finding === "av3Junctional" ||
          // His field along the penetration / septal His
          s.nearestId === "his";
        if ((isAfib || isFlutter) && s.tissue === "atrial") chamberOk = true;
        // AVRT: show field crossing the fibrous plane along the Kent insertion
        if (accessoryLive && nearKentAvCross(s.pos, s.nearestId)) chamberOk = true;
      } else if (opts.mark === "TP") {
        chamberOk = (isAfib || isFlutter) && s.tissue === "atrial";
      }
      if (
        (opts.finding === "avrtAntiLeft" ||
          opts.finding === "avrtAntiRight" ||
          opts.finding === "avrtOrthoLeft" ||
          opts.finding === "avrtOrthoRight") &&
        (opts.mark === "P" || opts.mark === "PR") &&
        (s.nearestId === "accessory" ||
          s.nearestId === "accessoryR" ||
          nearKentAvCross(s.pos, s.nearestId) ||
          (opts.finding.startsWith("avrtAnti") && s.tissue === "ventricular") ||
          fromMyoFocus)
      ) {
        chamberOk = true;
      }
      if (
        opts.finding === "vt" ||
        opts.finding === "vtMonoLbbb" ||
        opts.finding === "vtMonoRbbb" ||
        opts.finding === "vtPoly" ||
        opts.finding === "torsades" ||
        opts.finding === "vfCoarse" ||
        opts.finding === "vfFine" ||
        opts.finding === "av3"
      ) {
        chamberOk = s.tissue === "ventricular" || s.nearestId === "accessory" || s.nearestId === "accessoryR";
      } else if (fromMyoFocus && focusTissue === "atrial") {
        // PAC / AFib / atrial pace — AV-plane rule (accessory / AV corridor exceptions)
        chamberOk = atrialSourceMayDriveSample(
          s.pos,
          s.tissue,
          s.nearestId,
          accessoryLive,
          avNodeLive,
        );
      } else if (fromMyoFocus) {
        chamberOk = s.tissue === "ventricular" || s.nearestId === "accessory" || s.nearestId === "accessoryR";
      }

      // —— Local field = superposition of concurrent conduction activities ——
      // Magnitude / direction = vector sum; color = discrete dominant source.
      // As each activity fades, magnitude decays smoothly (no hard cut-off).
      const blockSideSample =
        (blockedChamber === "left" && s.pos.x > 0.04) ||
        (blockedChamber === "right" && s.pos.x < -0.04) ||
        (blockedFascicle === "laf" && s.pos.x > 0.12 && s.pos.z > -0.05) ||
        (blockedFascicle === "lpf" && s.pos.x > 0.1 && s.pos.z < -0.12);

      const lat =
        fromMyoFocus
          ? act
          : s.tissue === "atrial" || opts.mark === "P" || (opts.mark === "PR" && s.tissue !== "ventricular")
            ? act
            : mapSt && mapSt.lat < 1e8
              ? blockTerritory
                ? mapSt.lat
                : Math.min(mapSt.lat, act)
              : act;
      const recovery =
        s.tissue === "atrial"
          ? act + 0.16
          : mapSt?.recovery && mapSt.recovery < 1e8
            ? mapSt.recovery
            : act + 0.2;
      const apdSpan = Math.max(0.06, recovery - (lat < 1e8 ? lat : act));
      let depolAge = fieldAge(t, lat < 1e8 ? lat : act, longCycle);
      const delayedAge = depolAge - arrowDelayFrac;
      const depolarized = lat < 1e8 && t >= lat - 0.01 && t < recovery;
      const ballIntensity = depolarized
        ? Math.min(1, Math.max(0, 1 - Math.max(0, t - lat) / apdSpan))
        : 0;

      tmpFieldAcc.set(0, 0, 0);
      let totalW = 0;
      let bestW = 0;
      let bestColor =
        s.tissue === "ventricular" && mapSt.lat < 1e8 && mapSt.originColor
          ? mapSt.originColor
          : s.nearestColor;
      let frontIntensity = 0;
      let pathDrive = 0;
      let pvcDrive = 0;

      const addContrib = (w: number, d: THREE.Vector3, color: number) => {
        if (w < 0.012 || d.lengthSq() < 1e-10) return;
        tmpFieldAcc.addScaledVector(d, w);
        totalW += w;
        if (w > bestW) {
          bestW = w;
          bestColor = color;
        }
      };

      // 1) Live pathway fronts — sum all nearby wakes (His + both bundles, etc.)
      // BBB blocked free-wall: allow fronts near the septum so the cross is visible;
      // deep free-wall still waits on myocardial LAT (blockSideSample deep).
      const allowBlockSideFronts =
        blockSideSample &&
        ((blockedChamber === "left" && s.pos.x < 0.32) ||
          (blockedChamber === "right" && s.pos.x > -0.32) ||
          blockedFascicle != null);
      if (chamberOk && fieldFronts.length && (!blockSideSample || allowBlockSideFronts)) {
        const wantAtrial = s.tissue === "atrial";
        // AFib: PV pink wavefront owns the atrial field — don't let internodal yellow drown it
        const muteAtrialPath = isAfib && wantAtrial && fromMyoFocus;
        // AVRT: Kent owns atrial/cross-plane field — mute Bachmann / internodal / SA
        const muteBachmann = isAvrt && accessoryLive && (wantAtrial || nearKentAvCross(s.pos, s.nearestId));
        for (const f of fieldFronts) {
          const frontIsAtrial = f.atrial || isAtrialFrontId(f.id);
          const isAccessoryFront = f.id === "accessory" || f.id === "accessoryR";
          if (muteAtrialPath && frontIsAtrial) continue;
          if (muteBachmann && (f.id === "sa" || f.id === "internodal") && !isAccessoryFront) continue;
          // Atrial fronts never paint ventricle except AV-node corridor / accessory
          if (frontIsAtrial) {
            if (
              !atrialSourceMayDriveSample(s.pos, s.tissue, s.nearestId, accessoryLive, avNodeLive)
            ) {
              continue;
            }
          } else if (wantAtrial && f.id !== "av" && f.id !== "his" && !isAccessoryFront) {
            // Ventricular fronts stay out of the atria (His/AV/Kent may meet at the plane)
            continue;
          }
          if (
            wantAtrial !== frontIsAtrial &&
            f.id !== "his" &&
            f.id !== "av" &&
            !isAccessoryFront &&
            !(accessoryLive && nearKentAvCross(s.pos, s.nearestId))
          ) {
            continue;
          }
          tmpToFront.copy(s.pos).sub(f.pos);
          const along = tmpToFront.dot(f.dir);
          const lat2 = tmpToFront.lengthSq() - along * along;
          const latD = lat2 > 0 ? Math.sqrt(lat2) : 0;
          const flutterFront = f.id === "flutter";
          // Kent wake stays local to the accessory corridor — don't recolor distant HPS greens
          if (
            isAccessoryFront &&
            !nearKentAvCross(s.pos, s.nearestId) &&
            s.nearestId !== "accessory" &&
            s.nearestId !== "accessoryR" &&
            latD > 0.22
          ) {
            continue;
          }
          const lead = wantAtrial ? (flutterFront ? 0.14 : 0.1) : isAccessoryFront ? 0.12 : 0.14;
          const wake = wantAtrial ? (flutterFront ? 0.55 : 0.42) : isAccessoryFront ? 0.38 : 0.5;
          const sigma = wantAtrial ? (flutterFront ? 0.22 : 0.16) : isAccessoryFront ? 0.14 : 0.2;
          if (along > lead || along < -wake || latD > sigma * 2.8) continue;
          const alongW =
            along >= 0
              ? Math.exp(-(along * along) / (2 * lead * lead * 0.55))
              : Math.exp(along / (wake * 0.55));
          const latW = Math.exp(-(latD * latD) / (2 * sigma * sigma));
          const prog = 0.55 + 0.45 * Math.min(1, Math.max(0, f.progress));
          const w =
            alongW *
            latW *
            prog *
            frontMass(f.id) *
            (flutterFront ? 1.35 : isAccessoryFront ? 1.25 : 1);
          frontIntensity = Math.max(frontIntensity, w);
          // AVRT: accessory fronts always paint Kent purple
          const frontColor = isAccessoryFront
            ? SEGMENT_FIELD_COLOR[f.id] ?? 0xc070ff
            : f.color;
          tmpContribDir.copy(f.dir).lerp(s.dir, isAccessoryFront ? 0.08 : 0.18);
          projectOntoShellTangent(tmpContribDir, s.pos);
          // Atrial front dirs cannot aim across the plane outside His gap / accessory
          if (frontIsAtrial && !(accessoryLive && nearKentAvCross(s.pos, s.nearestId))) {
            clampDirToAvPlane(s.pos, tmpContribDir, true);
          }
          addContrib(w, tmpContribDir, frontColor);
        }
      }

      // 2) Myocardial activation current (LAT) — full strength until local PVC arrives.
      // Do not globally dim normal conduction while an ectopy wave is elsewhere.
      if (
        chamberOk &&
        !fieldRepol &&
        s.tissue === "ventricular" &&
        mapSt &&
        mapSt.lat < 1e8 &&
        delayedAge >= -0.05
      ) {
        // Local handoff only: once the PVC shell reaches this sample, ease pathway down
        const localPvc =
          fromMyoFocus && focusTissue === "ventricular" && shellReached
            ? Math.min(1, Math.max(0, 1 - focusLocalAge * 4))
            : 0;
        const env =
          fieldEnvelope(delayedAge, 0.04, apdSpan * 0.55) * (1 - 0.85 * localPvc);
        const fiber =
          mapSt.originSegmentId != null ? frontMass(mapSt.originSegmentId) : frontMass(s.nearestId);
        const myoW = env * (blockTerritory ? 1.05 : 0.9) * fiber;
        if (myoW > 0.01) {
          if (mapSt.depolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.depolDir);
          else tmpContribDir.copy(s.dir);
          if (inSeptum(s.pos)) {
            tmpOutward.copy(SEPTUM_WALL.longAxis);
            if (tmpOutward.y > 0) tmpOutward.negate();
            tmpContribDir.multiplyScalar(0.4).addScaledVector(tmpOutward, 0.6);
            tmpContribDir.y -= 0.25;
          } else {
            tmpOutward.copy(s.pos).sub(FIELD_ELLIPSOID.center);
            if (tmpOutward.lengthSq() > 1e-8) {
              tmpOutward.normalize();
              const inward = -tmpContribDir.dot(tmpOutward);
              if (inward > 0.2) tmpContribDir.addScaledVector(tmpOutward, inward * 1.8);
            }
            transmuralDepolBias(s.pos, tmpOutward);
            tmpContribDir.multiplyScalar(0.78).addScaledVector(tmpOutward, 0.22);
          }
          if (leftComplete && !rightComplete && s.pos.x > -0.08) tmpContribDir.x += 0.55;
          else if (rightComplete && !leftComplete && s.pos.x < 0.08) tmpContribDir.x -= 0.55;
          if (tmpContribDir.lengthSq() > 1e-10) tmpContribDir.normalize();
          const originHex =
            mapSt.originColor || SEGMENT_FIELD_COLOR[mapSt.originSegmentId!] || s.nearestColor;
          addContrib(myoW, tmpContribDir, originHex);
          pathDrive = Math.max(pathDrive, myoW);
        }
      } else if (chamberOk && !fieldRepol && s.tissue === "atrial") {
        // AFib: skip pathway atrial LAT — pink PV wave is the field driver
        // AVRT: accessory fronts own the atrium (not Bachmann / SA)
        const muteAtrialLat =
          (isAfib && fromMyoFocus) ||
          (isAvrt &&
            (liveSegments.has("accessory") ||
              liveSegments.has("accessoryR") ||
              accessoryLive));
        if (
          !muteAtrialLat &&
          atrialSourceMayDriveSample(s.pos, s.tissue, s.nearestId, accessoryLive, avNodeLive)
        ) {
          const env = fieldEnvelope(delayedAge, 0.035, 0.12);
          if (env > 0.01 && (groupOk || frontIntensity > 0.05)) {
            tmpContribDir.copy(s.dir);
            if (lmLive?.reverse) tmpContribDir.negate();
            projectOntoShellTangent(tmpContribDir, s.pos);
            if (!(accessoryLive && nearKentAvCross(s.pos, s.nearestId))) {
              clampDirToAvPlane(s.pos, tmpContribDir, true);
            }
            addContrib(env * 0.85 * frontMass(s.nearestId), tmpContribDir, s.nearestColor);
            pathDrive = Math.max(pathDrive, env);
          }
        }
      }

      // 3) Recovery current — same sequence as depol; discrete grey
      if (chamberOk && fieldRepol && s.tissue === "ventricular" && lat < 1e8) {
        let repolAge = fieldAge(t, recovery, longCycle);
        const env = fieldEnvelope(repolAge, 0.04, 0.12);
        if (env > 0.01) {
          if (mapSt.repolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.repolDir);
          else if (mapSt.depolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.depolDir);
          else transmuralRepolDir(s.pos, tmpContribDir);
          addContrib(env * 0.95, tmpContribDir, FIELD_REPOL_GREY);
          pathDrive = Math.max(pathDrive, env);
        }
      }

      // 4) Ectopy / pace / pre-excitation myocardial focus (incl. AFib PV pink wave)
      const allowFocusField =
        chamberOk &&
        fromMyoFocus &&
        !!focusDir &&
        !(fieldRepol && s.tissue === "ventricular");
      if (allowFocusField && focusDir) {
        const ageForEnv = fromMyoFocus ? focusLocalAge : depolAge;
        const kentFocus = focusColor === 0xc070ff || focusColor === 0xa060e8;
        // PVC: thin traveling ring. Kent pre-ex: slightly longer purple wake along accessory.
        const env = fieldEnvelope(
          ageForEnv,
          isAfib && focusTissue === "atrial" ? 0.035 : 0.035,
          isAfib && focusTissue === "atrial" ? 0.09 : kentFocus ? 0.14 : 0.09,
        );
        const fw =
          Math.max(env, engagedTract && !isAvrt ? 0.15 : 0) *
          (shellReached || (isAfib && focusTissue === "atrial") ? 1 : 0);
        if (fw > 0.01) {
          const col = focusColor ?? (kentFocus ? 0xc070ff : 0xff8844);
          if (
            focusTissue === "ventricular" &&
            mapSt.depolDir.lengthSq() > 1e-10 &&
            mapSt.lat < 1e8
          ) {
            tmpContribDir.copy(mapSt.depolDir);
            projectOntoShellTangent(tmpContribDir, s.pos);
            addContrib(fw * (kentFocus ? 1.45 : 1.25), tmpContribDir, col);
          } else {
            addContrib(fw * (isAfib && focusTissue === "atrial" ? 1.35 : kentFocus ? 1.4 : 1.2), focusDir, col);
          }
          pvcDrive = fw;
        }
      }
      if (
        chamberOk &&
        engagedTract &&
        !(fieldRepol && s.tissue === "ventricular") &&
        !(isAfib && focusTissue === "atrial") &&
        !isAvrt
      ) {
        // Late Purkinje engage after PVC — use tract tangent (traveling), not radial
        tmpContribDir.copy(s.dir);
        addContrib(0.28, tmpContribDir, focusColor ?? s.nearestColor);
        pvcDrive = Math.max(pvcDrive, 0.28);
      }

      // Ectopy: mute remapped pathway ahead of the shell
      if (anyEctopyWave && !shellReached && !fromMyoFocus && !(fieldRepol && s.tissue === "ventricular")) {
        const atrialWave = liveFoci.some((f) => f.waveActive && f.tissue === "atrial");
        if ((atrialWave && s.tissue === "atrial") || (!atrialWave && s.tissue === "ventricular")) {
          if (frontIntensity < 0.14) {
            tmpFieldAcc.set(0, 0, 0);
            totalW = 0;
            bestW = 0;
          }
        }
      }

      // Anterograde AV-plane rules:
      // - Ventricular field must not float above the fibrous plane (except His corridor)
      // - Atrial field must not cross into ventricle except AV-node gap or accessory
      const allowAvCross =
        accessoryLive ||
        preExLive ||
        (fromMyoFocus && focusTissue === "ventricular") ||
        opts.finding === "vt" ||
        opts.finding === "vtMonoLbbb" ||
        opts.finding === "vtMonoRbbb" ||
        opts.finding === "vtPoly" ||
        opts.finding === "torsades" ||
        opts.finding === "vfCoarse" ||
        opts.finding === "vfFine";
      const aboveAvPlane = s.pos.y > AV_JUNCTION.planeY + 0.005;
      const belowAvPlane = s.pos.y < AV_JUNCTION.planeY - 0.01;
      const inHisCorridor = nearHisPenetration(s.pos, AV_JUNCTION.hisGapR * 2.4);
      const junctionBlocked =
        !allowAvCross &&
        aboveAvPlane &&
        (s.tissue === "ventricular" ||
          s.nearestId === "rbb" ||
          s.nearestId === "lbb" ||
          s.nearestId === "lbba" ||
          s.nearestId === "lbbp" ||
          s.nearestId === "purkinjeL" ||
          s.nearestId === "purkinjeR") &&
        !inHisCorridor;
      // Atrial-colored / atrial-sourced field on ventricular free wall → kill
      const atrialLeakBlocked =
        !allowAvCross &&
        belowAvPlane &&
        s.tissue === "ventricular" &&
        !inHisCorridor &&
        !(avNodeLive && (s.nearestId === "av" || s.nearestId === "his") && inHisCorridor) &&
        (isAtrialFieldColor(bestColor) ||
          s.nearestId === "sa" ||
          s.nearestId === "internodal" ||
          s.nearestId === "flutter" ||
          s.nearestId === "myocardiumA");
      if (junctionBlocked || atrialLeakBlocked) {
        tmpFieldAcc.set(0, 0, 0);
        totalW = 0;
        bestW = 0;
      }

      // Resultant magnitude at this sample (physiologic local field strength)
      let targetMag = 0;
      if (chamberOk && !junctionBlocked && !atrialLeakBlocked && totalW > 1e-4) {
        const vecMag = tmpFieldAcc.length();
        targetMag = Math.min(1.4, vecMag * 0.75 + totalW * 0.28);
      }

      // Smooth toward target: slower fall so orange doesn't snap off when pathway arrives
      if (targetMag > s.glow) s.glow += (targetMag - s.glow) * 0.42;
      else s.glow += (targetMag - s.glow) * 0.045;
      if (!chamberOk || junctionBlocked || atrialLeakBlocked) s.glow *= 0.88;
      if (s.glow < 0.008) s.glow = 0;

      // Soft handoff weight — only when this sample has local PVC drive (not global)
      const blendTarget =
        pathDrive + pvcDrive < 1e-4
          ? s.pvcBlend * 0.92
          : pvcDrive / (pathDrive + pvcDrive + 1e-6);
      s.pvcBlend = s.pvcBlend * 0.88 + blendTarget * 0.12;
      if (!chamberOk) s.pvcBlend *= 0.94;
      // AVRT never uses PVC orange blend
      if (isAvrt) s.pvcBlend = 0;

      const intensity = s.glow;
      const show = intensity > 0.04;

      let dir = tmpPathDir;
      if (tmpFieldAcc.lengthSq() > 1e-8) {
        dir.copy(tmpFieldAcc).normalize();
      } else if (fieldRepol && s.tissue === "ventricular" && mapSt.repolDir.lengthSq() > 1e-10) {
        dir.copy(mapSt.repolDir);
      } else if (mapSt && mapSt.lat < 1e8 && mapSt.depolDir.lengthSq() > 1e-10) {
        dir.copy(mapSt.depolDir);
      } else {
        dir.copy(s.dir);
      }
      if (dir.lengthSq() > 1e-10) {
        clampDirToAvPlane(s.pos, dir, !allowAvCross);
        s.dirSmooth.lerp(dir, show ? 0.32 : 0.08);
        if (s.dirSmooth.lengthSq() > 1e-8) s.dirSmooth.normalize();
        dir = s.dirSmooth;
        if (!allowAvCross) clampDirToAvPlane(s.pos, dir, true);
      }

      const kentPurple = SEGMENT_FIELD_COLOR.accessory ?? 0xc070ff;
      const isKentColor = (hex: number) =>
        hex === kentPurple || hex === (SEGMENT_FIELD_COLOR.accessoryR ?? 0xa060e8) || hex === 0xc070ff;
      // Purple only where Kent actually dominates this sample — never recolor the whole loop
      const kentDrivingLocal =
        isAvrt &&
        ((bestW > 0.02 && isKentColor(bestColor)) ||
          (fromMyoFocus &&
            focusColor != null &&
            isKentColor(focusColor) &&
            (nearKentAvCross(s.pos, s.nearestId) ||
              s.nearestId === "accessory" ||
              s.nearestId === "accessoryR")));

      // Color follows local dominant source (green HPS stays green; Kent stays purple)
      let displayColor: number;
      if (kentDrivingLocal) {
        displayColor = kentPurple;
        s.colorSmooth.lerp(tmpWaveColor.setHex(displayColor), show ? 0.3 : 0.1);
        displayColor = s.colorSmooth.getHex();
      } else if (isAvrt) {
        displayColor =
          bestW > 0.02
            ? bestColor
            : s.tissue === "ventricular" && mapSt.lat < 1e8 && mapSt.originColor
              ? mapSt.originColor
              : s.nearestColor;
        // Never let PVC-orange bleed into AVRT
        if (isEctopyFieldColor(displayColor)) {
          displayColor =
            s.tissue === "ventricular" && mapSt.lat < 1e8 && mapSt.originColor
              ? mapSt.originColor
              : s.nearestColor;
        }
        s.colorSmooth.lerp(tmpWaveColor.setHex(displayColor), show ? 0.28 : 0.1);
        displayColor = s.colorSmooth.getHex();
      } else {
        let pathColor =
          fieldRepol && s.tissue === "ventricular" && !isAfib
            ? FIELD_REPOL_GREY
            : bestW > 0.02 && !isEctopyFieldColor(bestColor)
              ? bestColor
              : s.tissue === "ventricular" && mapSt.lat < 1e8 && mapSt.originColor
                ? mapSt.originColor
                : s.nearestColor;
        if (
          s.tissue === "ventricular" &&
          isAtrialFieldColor(pathColor) &&
          !accessoryLive &&
          !(avNodeLive && inHisCorridor && (s.nearestId === "av" || s.nearestId === "his"))
        ) {
          pathColor =
            mapSt.lat < 1e8 && mapSt.originColor && !isAtrialFieldColor(mapSt.originColor)
              ? mapSt.originColor
              : isAtrialFieldColor(s.nearestColor)
                ? 0x7ad4ff
                : s.nearestColor;
        }
        const ectopyHex =
          focusColor && !isKentColor(focusColor)
            ? focusColor
            : isEctopyFieldColor(bestColor) && !isKentColor(bestColor)
              ? bestColor
              : 0xff8844;
        const blend = fieldRepol ? 0 : Math.min(1, Math.max(0, s.pvcBlend));
        const targetCol = tmpWaveColor.setHex(pathColor).lerp(tmpEctopyColor.setHex(ectopyHex), blend);
        s.colorSmooth.lerp(targetCol, show ? 0.22 : 0.08);
        displayColor = s.colorSmooth.getHex();
      }

      if (fieldGroup.visible) {
        if (!show) {
          s.arrow.visible = false;
        } else {
          const arrowIntensity = intensity;
          const len = 0.055 + 0.14 * arrowIntensity;
          s.arrow.visible = true;
          s.arrow.position.copy(s.pos);
          s.arrow.setDirection(dir);
          s.arrow.setLength(len, len * 0.32, len * 0.2);
          s.arrow.setColor(displayColor);
          const lm = s.arrow.line.material;
          const cm = s.arrow.cone.material;
          const op =
            fieldRepol && displayColor === FIELD_REPOL_GREY
              ? 0.12 + 0.38 * arrowIntensity
              : 0.1 + 0.62 * arrowIntensity;
          if (lm instanceof THREE.LineBasicMaterial) lm.opacity = op;
          if (cm instanceof THREE.MeshBasicMaterial) cm.opacity = op;
        }
        s.ball.visible = false;
      } else {
        s.arrow.visible = false;
        s.ball.visible = false;
        s.glow = 0;
        s.pvcBlend = 0;
      }

      // Mathematical resultant: sum local depol directions while actively depolarized
      if (depolarized && s.tissue === "ventricular" && dir.lengthSq() > 1e-8) {
        const w = ballIntensity * (s.tissue === "ventricular" ? 1.1 : 0.6);
        tmpSum.addScaledVector(dir, w);
        nMyo += w;
        nActive += w * 0.35;
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
                ? 0x9aa4ae
                : opts.mark === "ST"
                  ? 0x6ec896
                  : 0x3db8c8;
          targetWave =
            opts.mark === "P" || opts.mark === "PR"
              ? 0xf0c040
              : opts.mark === "T"
                ? 0x9aa4ae
                : opts.mark === "ST"
                  ? 0x8aa0ae
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

      // Resultant stays at model center; only its direction tracks the lead dipole / field mean
      smoothMeanOrigin.copy(RESULTANT_ORIGIN);

      const baseLen =
        opts.mark === "QRS"
          ? 1.2
          : opts.mark === "T"
            ? 0.95
            : opts.mark === "P" || opts.mark === "PR"
              ? 0.85
              : opts.mark === "ST"
                ? 0.65
                : isAfib
                  ? 0.5
                  : 0.6;
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
    cycleSec?: number;
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
      pathwayGroup.visible = false;
      smoothMeanReady = false;
      smoothMeanStrength = 0;
      for (const m of focusMarkers) m.visible = false;
      for (const r of focusRings) r.visible = false;
      for (const a of branchArrows) a.visible = false;
      for (const s of samples) {
        s.arrow.visible = false;
        s.ball.visible = false;
      }
      return;
    }
    updatePhysiologic(opts);
  }

  return {
    root,
    setMeanVisible: (v: boolean) => {
      meanGroup.visible = v;
      pathwayGroup.visible = v;
      if (!v) {
        smoothMeanReady = false;
        smoothMeanStrength = 0;
        for (const a of branchArrows) a.visible = false;
      }
    },
    setFieldVisible: (v: boolean) => {
      fieldGroup.visible = v;
    },
    getQrsDurationSec: (cycleSec: number) =>
      Math.max(0.06, Math.min(0.28, lastQrsFrac * Math.max(0.25, cycleSec))),
    getQrsFrac: () => lastQrsFrac,
    update,
  };
}
