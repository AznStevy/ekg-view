import * as THREE from "three";
import type { CycleMark, LeadId } from "./ekgWaveforms";
import type { FindingId, SegmentId } from "./findings";
import { avrtKentSide } from "./findings";
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
  type ActivationGraph,
  type ActivationMapResult,
  type ActivationSeed,
} from "./activationMap";
import { fitCardiacVector } from "./leadAxes";
import { KENT_ATRIAL_INSERT } from "./ectopyFocus";
import type { ActiveFront, BranchWindow, PathwayProbePoint } from "./pathwayTiming";
import {
  branchesForFinding,
  effectiveImpulseWindow,
  groupsForMark,
  PURKINJE_L_LAF_CURVES,
  PURKINJE_L_LPF_CURVES,
  PURKINJE_L_SEPTAL_CURVES,
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

/** Short display lag: intact ventricular field is fully engaged near the R peak. */
/** Field arrows track myocardial LAT closely so the QRS and ventricular field match. */
const ARROW_AFTER_DEPOL_SEC = 0.003;

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

/**
 * Traveling activation front with a soft dissipating trail (not a hard snap-off).
 */
function activationWavefront(age: number, width = 0.055): number {
  if (!Number.isFinite(age)) return 0;
  const w = Math.max(0.028, width);
  if (age < -w * 0.55) return 0;
  if (age < 0) {
    const x = 1 + age / (w * 0.55);
    return Math.max(0, x * x);
  }
  // Long exponential wake — field dissipates behind the crest instead of snapping off
  return Math.exp(-age / (w * 2.85));
}

/**
 * Ventricular recovery envelope — crest at local recovery + soft T-wave trail.
 */
function recoveryEnvelope(age: number): number {
  if (!Number.isFinite(age) || age < -0.04) return 0;
  if (age < 0) {
    const x = 1 + age / 0.04;
    return Math.max(0, x * x);
  }
  const crest = Math.exp(-(age * age) / (2 * 0.055 * 0.055));
  const trail = age < 0.48 ? Math.exp(-age / 0.2) * 0.7 : 0;
  return Math.max(crest, trail);
}

/**
 * Age since an activation / recovery event (cycle fraction).
 * Never wrap large negative ages into the positive window — that resurrected the
 * previous beat's late LV recovery as grey field *before* the next depolarization.
 */
function fieldAge(t: number, eventT: number, longCycle: boolean): number {
  let age = t - eventT;
  if (!Number.isFinite(age)) return -1;
  if (longCycle) {
    if (age < -0.06) return -1;
    return age;
  }
  // Only fold a finished positive trail that ran past mid-cycle into the next
  // strip coordinate — never promote "before this event" into "during trail".
  if (age > 0.85) age -= 1;
  return age;
}

/** True for atrial myocardium / internodal / flutter / PV-focus / RA-pace colors. */
function isAtrialFieldColor(hex: number): boolean {
  return (
    hex === 0xf0c040 ||
    hex === 0xe8a838 ||
    hex === 0xe040fb ||
    hex === 0xd08090 ||
    hex === 0xff8a1a || // RA appendage pace lead
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

function isKentFieldColor(hex: number): boolean {
  return (
    hex === (SEGMENT_FIELD_COLOR.accessory ?? 0xc070ff) ||
    hex === (SEGMENT_FIELD_COLOR.accessoryR ?? 0xa060e8) ||
    hex === 0xc070ff
  );
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
  // Left Kent hugs the mitral AV groove (at / below the fibrous plane); right Kent
  // the tricuspid groove — allow a tall vertical band so a low annulus path still counts.
  const py = AV_JUNCTION.planeY;
  const nearGroove = pos.y < py + 0.14 && pos.y > py - 0.32;
  if (!nearGroove) return false;
  const leftKent = pos.x > 0.32 && pos.z > -0.2 && pos.z < 0.38;
  const rightKent = pos.x < -0.32 && pos.z > -0.08 && pos.z < 0.5;
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
 * Left network is anatomically broader — green must light as LBB travels;
 * right stays present but must not flood the whole ventricle.
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
      return 0.85;
    case "lbb":
      return 1.85;
    case "lbbp":
      return 1.55;
    case "lbba":
      return 1.5;
    case "purkinjeL":
      return 1.7;
    case "rbb":
      return 1.05;
    case "purkinjeR":
      return 1.1;
    case "accessory":
    case "accessoryR":
      return 1.45;
    default:
      return 1;
  }
}

function isLeftHpsId(id: SegmentId | undefined): boolean {
  return id === "lbb" || id === "lbba" || id === "lbbp" || id === "purkinjeL";
}

function isRightHpsId(id: SegmentId | undefined): boolean {
  return id === "rbb" || id === "purkinjeR";
}

/** Mild left preference — LV territory larger; right still lights with RBB tip. */
function hpsFieldBalance(id: SegmentId | undefined): number {
  if (isLeftHpsId(id)) return 1.15;
  if (isRightHpsId(id)) return 0.95;
  return 1;
}

/**
 * Near the AV base, shell-tangents can go circumferential (sideways ring).
 * Soften that without forcing arrows apexward/down — basal trajectories should
 * keep their LAT direction and stop at the fibrous plane via length clipping.
 */
function biasVentricularApexward(dir: THREE.Vector3, pos: THREE.Vector3): void {
  if (pos.y <= AV_JUNCTION.planeY - 0.28) return;
  const basal = Math.max(0, 1 - (AV_JUNCTION.planeY - pos.y) / 0.28);
  // Remove circumferential (sideways ring) component in the XZ plane around the axis
  const circX = -pos.z;
  const circZ = pos.x;
  const circLen = Math.hypot(circX, circZ);
  if (circLen > 1e-6) {
    const ux = circX / circLen;
    const uz = circZ / circLen;
    const circDot = dir.x * ux + dir.z * uz;
    dir.x -= ux * circDot * (0.55 + 0.35 * basal);
    dir.z -= uz * circDot * (0.55 + 0.35 * basal);
  }
  if (dir.lengthSq() > 1e-10) dir.normalize();
}

/**
 * Shorten an arrow so its tip stops at the AV fibrous plane when the trajectory
 * would cross it outside the His gap — keeps direction, clips length only.
 */
function clipLenAtAvPlane(pos: THREE.Vector3, dir: THREE.Vector3, len: number): number {
  if (len < 1e-4 || dir.lengthSq() < 1e-10 || Math.abs(dir.y) < 1e-6) return len;
  const py = AV_JUNCTION.planeY;
  const t = (py - pos.y) / dir.y;
  if (t <= 0.012 || t >= len) return len;
  const hitX = pos.x + dir.x * t;
  const hitZ = pos.z + dir.z * t;
  if (nearHisPenetration([hitX, py, hitZ], AV_JUNCTION.hisGapR * 1.2)) return len;
  return Math.max(0.016, t * 0.92);
}

/** Inferior His propagation with mild divergence toward each side of the septum. */
function setHisPropagationDir(
  out: THREE.Vector3,
  samplePos: THREE.Vector3,
  frontPos: THREE.Vector3,
): void {
  out.set(samplePos.x - frontPos.x, 0, samplePos.z - frontPos.z);
  if (out.lengthSq() > 1e-8) out.normalize().multiplyScalar(0.28);
  else out.set(samplePos.x >= frontPos.x ? 0.22 : -0.22, 0, 0);
  out.y = -1;
  out.normalize();
}

/** True if hex is an RV / right-HPS field color. */
function isRightFieldColor(hex: number): boolean {
  return hex === 0x5ec8ff || hex === 0x7ad4ff || hex === SEGMENT_FIELD_COLOR.rbb || hex === SEGMENT_FIELD_COLOR.purkinjeR;
}

/** True if hex is an LV / left-HPS field color. */
function isLeftFieldColor(hex: number): boolean {
  return (
    hex === 0x6ae0a8 ||
    hex === 0x88f0c0 ||
    hex === 0x4ec890 ||
    hex === 0x3ab078 ||
    hex === SEGMENT_FIELD_COLOR.lbb ||
    hex === SEGMENT_FIELD_COLOR.lbba ||
    hex === SEGMENT_FIELD_COLOR.lbbp ||
    hex === SEGMENT_FIELD_COLOR.purkinjeL
  );
}

/**
 * Hard chamber color lock for NSR teaching: blue stays in RV, green in LV.
 * Complete BBB: allow intact-side color to paint the blocked free wall (myocardial fill).
 */
function chamberLockedFieldColor(
  pos: THREE.Vector3,
  color: number,
  originId?: SegmentId,
  blockedChamber?: "left" | "right" | null,
): number {
  if (Math.abs(pos.x) < 0.1) return color;
  // LBBB: blue (right) may own LV free wall; RBBB: green may own RV free wall
  if (blockedChamber === "left" && pos.x > 0.06) return color;
  if (blockedChamber === "right" && pos.x < -0.06) return color;
  if (pos.x > 0.1 && (isRightHpsId(originId) || isRightFieldColor(color))) {
    return SEGMENT_FIELD_COLOR.purkinjeL ?? 0x88f0c0;
  }
  if (pos.x < -0.1 && (isLeftHpsId(originId) || isLeftFieldColor(color))) {
    return SEGMENT_FIELD_COLOR.purkinjeR ?? 0x5ec8ff;
  }
  return color;
}

/**
 * Recovery arrows follow how *this* region activated — stay in the same ventricle.
 * Raw LAT gradients often point at late LV wall and make every arrow stream leftward.
 */
function fillChamberLocalRepolDir(
  out: THREE.Vector3,
  depolDir: THREE.Vector3,
  localFiber: THREE.Vector3,
  originId: SegmentId | undefined,
  pos: THREE.Vector3,
): void {
  if (depolDir.lengthSq() > 1e-10) out.copy(depolDir);
  else out.copy(localFiber);
  // Local Purkinje / bundle tangent keeps each chamber's own sense of travel
  out.lerp(localFiber, 0.45);

  const rightSide =
    isRightHpsId(originId) || (!isLeftHpsId(originId) && pos.x < -0.06);
  const leftSide =
    isLeftHpsId(originId) || (!isRightHpsId(originId) && pos.x > 0.1);

  if (rightSide) {
    // RV: suppress contralateral (+X / LV) pull from the global LAT gradient
    if (out.x > 0) out.x *= 0.12;
    if (localFiber.x < 0) out.x += localFiber.x * 0.35;
  } else if (leftSide) {
    // LV: suppress contralateral (−X / RV) pull
    if (out.x < 0) out.x *= 0.12;
    if (localFiber.x > 0) out.x += localFiber.x * 0.35;
  }

  projectOntoShellTangent(out, pos);
  biasVentricularApexward(out, pos);
  if (out.lengthSq() > 1e-10) out.normalize();
  else {
    out.copy(localFiber);
    if (out.lengthSq() > 1e-10) out.normalize();
    else out.set(pos.x >= 0 ? 1 : -1, -0.55, 0).normalize();
  }
}

/**
 * EKG QRS mark window (cycle fraction) — ventricular field depol must live here.
 * Matches NSR_WINDOWS in ekgWaveforms (His → end of Purkinje depolarization).
 */
function qrsDepolWindow(finding: FindingId): { t0: number; t1: number } {
  switch (finding) {
    case "sinusTachy":
      return { t0: 0.22, t1: 0.38 };
    case "avrtAntiLeft":
    case "avrtAntiRight":
      return { t0: 0.08, t1: 0.4 };
    case "lbbb":
    case "rbbb":
    case "rbbbLafb":
    case "rbbbLpfb":
      return { t0: 0.26, t1: 0.52 };
    case "pvc":
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
      return { t0: 0.28, t1: 0.55 };
    default:
      return { t0: 0.275, t1: 0.32 };
  }
}

/**
 * True when the strip has one ventricular activation near the fixed NSR QRS window.
 * Multi-beat / irregular findings keep absolute branch-timed LATs (no remap).
 */
function findingUsesFixedQrsAlign(finding: FindingId): boolean {
  switch (finding) {
    case "afib":
    case "aflutterCcw":
    case "aflutterCw":
    case "av2i":
    case "av2ii":
    case "av21":
    case "av31":
    case "pvc":
    case "pac":
    case "sinusPause":
    case "saExitBlock":
    case "sickSinus":
    case "tachyBrady":
    case "failureToPace":
    case "failureToCapture":
    case "failureToSense":
    case "torsades":
    case "av3":
    case "av3Junctional":
    case "vfCoarse":
    case "vfFine":
      return false;
    default:
      return true;
  }
}

/**
 * EKG T-wave mark window — both ventricles' grey recovery must live here together.
 * Matches NSR_WINDOWS T (ventricular repolarization).
 */
function tWaveRepolWindow(finding: FindingId): { t0: number; t1: number } {
  switch (finding) {
    case "sinusTachy":
      return { t0: 0.42, t1: 0.62 };
    case "avrtAntiLeft":
    case "avrtAntiRight":
      return { t0: 0.48, t1: 0.72 };
    case "lbbb":
    case "rbbb":
    case "rbbbLafb":
    case "rbbbLpfb":
      return { t0: 0.54, t1: 0.78 };
    case "pvc":
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
      return { t0: 0.56, t1: 0.82 };
    default:
      return { t0: 0.54, t1: 0.74 };
  }
}

/**
 * Remap ventricular LATs into the EKG QRS window (order-preserving).
 * NSR / no complete BBB: left and right chambers are each stretched onto the
 * *same* QRS window so both ventricles depolarize together.
 * With LBBB/RBBB: one global remap keeps the blocked-side delay.
 */
function alignVentricularLatToQrs(
  map: ActivationMapResult,
  finding: FindingId,
  samples: { tissue: string; pos: THREE.Vector3 }[],
  syncChambers: boolean,
): void {
  const { t0: q0, t1: q1 } = qrsDepolWindow(finding);
  const targetSpan = Math.max(0.04, q1 - q0);

  const sideOf = (pos: THREE.Vector3): "left" | "right" | "septum" => {
    if (Math.abs(pos.x) < 0.08) return "septum";
    return pos.x >= 0 ? "left" : "right";
  };

  const remap = (lat: number, a0: number, a1: number): number => {
    if (!(a1 > a0) || !Number.isFinite(a0)) return q0 + 0.45 * targetSpan;
    const u = Math.min(1, Math.max(0, (lat - a0) / (a1 - a0)));
    return q0 + u * targetSpan;
  };

  if (!syncChambers) {
    // Complete BBB: shift so earliest LAT meets QRS onset, but KEEP absolute delays
    // so myocardial fill of the blocked chamber continues through late QRS / ST.
    const v0 = map.ventLatMin;
    const v1 = map.ventLatMax;
    if (!(v1 > v0) || v0 >= 1e8) {
      map.ventLatMin = q0;
      map.ventLatMax = q1;
      map.qrsFrac = targetSpan;
      return;
    }
    const shift = q0 - v0;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (let i = 0; i < map.samples.length; i++) {
      if (samples[i]?.tissue !== "ventricular") continue;
      const st = map.samples[i]!;
      if (st.lat >= 1e8) continue;
      // QRS alignment may delay activation, but it must never move myocardium
      // ahead of the conduction-derived arrival that seeded the LAT map.
      const conductionLat = st.lat;
      st.lat = Math.max(conductionLat, conductionLat + shift);
      st.recovery = st.lat + st.apd;
      minLat = Math.min(minLat, st.lat);
      maxLat = Math.max(maxLat, st.lat);
    }
    map.ventLatMin = Number.isFinite(minLat) ? minLat : q0;
    map.ventLatMax = maxLat;
    map.qrsFrac = Math.max(targetSpan, maxLat - map.ventLatMin);
    return;
  }

  // Intact NSR: per-chamber stretch onto the shared QRS window
  let l0 = Infinity;
  let l1 = -Infinity;
  let r0 = Infinity;
  let r1 = -Infinity;
  let s0 = Infinity;
  let s1 = -Infinity;
  for (let i = 0; i < map.samples.length; i++) {
    if (samples[i]?.tissue !== "ventricular") continue;
    const st = map.samples[i]!;
    if (st.lat >= 1e8) continue;
    const side = sideOf(samples[i]!.pos);
    if (side === "left") {
      l0 = Math.min(l0, st.lat);
      l1 = Math.max(l1, st.lat);
    } else if (side === "right") {
      r0 = Math.min(r0, st.lat);
      r1 = Math.max(r1, st.lat);
    } else {
      s0 = Math.min(s0, st.lat);
      s1 = Math.max(s1, st.lat);
    }
  }
  // If one free wall is missing, fall back to the other / septum
  if (!(l1 > l0)) {
    l0 = Number.isFinite(s0) ? s0 : r0;
    l1 = Number.isFinite(s1) ? s1 : r1;
  }
  if (!(r1 > r0)) {
    r0 = Number.isFinite(s0) ? s0 : l0;
    r1 = Number.isFinite(s1) ? s1 : l1;
  }
  const mid0 = Math.min(l0, r0, Number.isFinite(s0) ? s0 : Infinity);
  const mid1 = Math.max(l1, r1, Number.isFinite(s1) ? s1 : -Infinity);

  for (let i = 0; i < map.samples.length; i++) {
    if (samples[i]?.tissue !== "ventricular") continue;
    const st = map.samples[i]!;
    if (st.lat >= 1e8) continue;
    const conductionLat = st.lat;
    const side = sideOf(samples[i]!.pos);
    const alignedLat =
      side === "left"
        ? remap(conductionLat, l0, l1)
        : side === "right"
          ? remap(conductionLat, r0, r1)
          : remap(conductionLat, mid0, mid1);
    // Keep local arrows causally behind their bundle/Purkinje arrival.
    st.lat = Math.max(conductionLat, alignedLat);
    st.recovery = st.lat + st.apd;
  }
  let alignedMin = Infinity;
  let alignedMax = -Infinity;
  for (let i = 0; i < map.samples.length; i++) {
    if (samples[i]?.tissue !== "ventricular") continue;
    const lat = map.samples[i]!.lat;
    if (lat >= 1e8) continue;
    alignedMin = Math.min(alignedMin, lat);
    alignedMax = Math.max(alignedMax, lat);
  }
  map.ventLatMin = Number.isFinite(alignedMin) ? alignedMin : q0;
  map.ventLatMax = Number.isFinite(alignedMax) ? alignedMax : q0 + targetSpan;
  map.qrsFrac = Math.max(targetSpan, map.ventLatMax - map.ventLatMin);
}

/**
 * Remap ventricular recovery into the EKG T window (order-preserving).
 * Intact NSR: L and R each map onto the same T window so grey crests together.
 * With complete BBB: one global remap keeps delayed-chamber recovery late.
 */
function alignVentricularRecoveryToT(
  map: ActivationMapResult,
  finding: FindingId,
  samples: { tissue: string; pos: THREE.Vector3 }[],
  syncChambers: boolean,
): void {
  const { t0: r0Target, t1: r1Target } = tWaveRepolWindow(finding);
  const targetSpan = Math.max(0.12, r1Target - r0Target);

  const sideOf = (pos: THREE.Vector3): "left" | "right" | "septum" => {
    if (Math.abs(pos.x) < 0.08) return "septum";
    return pos.x >= 0 ? "left" : "right";
  };

  const remap = (rec: number, a0: number, a1: number): number => {
    if (!(a1 > a0) || !Number.isFinite(a0)) return r0Target + 0.45 * targetSpan;
    const u = Math.min(1, Math.max(0, (rec - a0) / (a1 - a0)));
    return r0Target + u * targetSpan;
  };

  // Refresh recovery from current LAT+APD first
  for (let i = 0; i < map.samples.length; i++) {
    if (samples[i]?.tissue !== "ventricular") continue;
    const st = map.samples[i]!;
    if (st.lat >= 1e8) continue;
    st.recovery = st.lat + st.apd;
  }

  if (!syncChambers) {
    // Complete BBB: do NOT squash recovery into the T window — late-activated
    // blocked myocardium recovers only after its own (late) depolarization.
    // Tissue that never activates keeps recovery = INF (set in the map builder).
    for (let i = 0; i < map.samples.length; i++) {
      if (samples[i]?.tissue !== "ventricular") continue;
      const st = map.samples[i]!;
      if (st.lat >= 1e8) {
        st.recovery = 1e9;
        continue;
      }
      st.recovery = st.lat + st.apd;
    }
    return;
  }

  let l0 = Infinity;
  let l1 = -Infinity;
  let r0 = Infinity;
  let r1 = -Infinity;
  let s0 = Infinity;
  let s1 = -Infinity;
  for (let i = 0; i < map.samples.length; i++) {
    if (samples[i]?.tissue !== "ventricular") continue;
    const st = map.samples[i]!;
    if (st.lat >= 1e8) continue;
    const side = sideOf(samples[i]!.pos);
    if (side === "left") {
      l0 = Math.min(l0, st.recovery);
      l1 = Math.max(l1, st.recovery);
    } else if (side === "right") {
      r0 = Math.min(r0, st.recovery);
      r1 = Math.max(r1, st.recovery);
    } else {
      s0 = Math.min(s0, st.recovery);
      s1 = Math.max(s1, st.recovery);
    }
  }
  if (!(l1 > l0)) {
    l0 = Number.isFinite(s0) ? s0 : r0;
    l1 = Number.isFinite(s1) ? s1 : r1;
  }
  if (!(r1 > r0)) {
    r0 = Number.isFinite(s0) ? s0 : l0;
    r1 = Number.isFinite(s1) ? s1 : l1;
  }
  const mid0 = Math.min(l0, r0, Number.isFinite(s0) ? s0 : Infinity);
  const mid1 = Math.max(l1, r1, Number.isFinite(s1) ? s1 : -Infinity);

  for (let i = 0; i < map.samples.length; i++) {
    if (samples[i]?.tissue !== "ventricular") continue;
    const st = map.samples[i]!;
    if (st.lat >= 1e8) continue;
    const side = sideOf(samples[i]!.pos);
    if (side === "left") st.recovery = remap(st.recovery, l0, l1);
    else if (side === "right") st.recovery = remap(st.recovery, r0, r1);
    else st.recovery = remap(st.recovery, mid0, mid1);
    st.apd = Math.max(0.08, st.recovery - st.lat);
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
      opacity: 0.28,
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
      const d0 = pos.distanceToSquared(probePos[i]!);
      // Prefer left HPS for LV wall binding so green owns the LV
      let d = d0;
      if (tissue === "ventricular") {
        if (isLeftHpsId(id)) d *= 0.55;
        else if (isRightHpsId(id)) d *= 1.45;
        // Hard: never bind LV free wall to right HPS or RV to left HPS
        if (pos.x > 0.12 && isRightHpsId(id)) d *= 8;
        if (pos.x < -0.12 && isLeftHpsId(id)) d *= 8;
      }
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { idx: best, dist: Math.sqrt(bestD) };
  }

  const minSep2 = 0.03 * 0.03;
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

    // Thin skip only right under the fibrous plane on free wall — keep basal
    // ventricular field so arrows fill up toward the AV groove. Insulator samples
    // on the plane itself are kept (grey AV-plane markers).
    if (tissue === "ventricular" && !septal && y > AV_JUNCTION.planeY - 0.08) {
      return;
    }

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
      // AV fibrous plane markers — dots only, never up-arrows (insulator has no current)
      samples.push({
        pos,
        tissue,
        nearestId: "his",
        nearestColor: 0x9aa4ae,
        dir: new THREE.Vector3(1, 0, 0),
        dirSmooth: new THREE.Vector3(1, 0, 0),
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
    // Ventricular free-wall: keep pathway tangent only — an outward probe→sample
    // blend made arrows look radial / disorganized on the shell.
    const dir = tangent.clone();
    if (tissue !== "ventricular" || inSeptum(pos)) {
      const outward = pos.clone().sub(probePos[idx]!);
      if (outward.lengthSq() > 1e-8) {
        outward.normalize();
        dir.multiplyScalar(0.85).addScaledVector(outward, 0.15);
      }
    }
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

  // Free-wall shell: fine angular lattice on mid-wall depths.
  // One coherent surface family (not epi/endo extremes fighting each other).
  {
    const { center, radius, innerLimit, outerLimit } = FIELD_ELLIPSOID;
    const depthFracs = [0.38, 0.68];
    const nLat = 25;
    for (let iLat = 0; iLat < nLat; iLat++) {
      const lat = -Math.PI * 0.5 + ((iLat + 0.5) / nLat) * Math.PI;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const nLon = Math.max(15, Math.round(18 + 22 * Math.abs(cosLat)));
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
    // Extra LV free-wall samples — densify left territory on the same mid-wall band
    const nLatL = 20;
    for (let iLat = 0; iLat < nLatL; iLat++) {
      const lat = -Math.PI * 0.45 + ((iLat + 0.5) / nLatL) * Math.PI * 0.85;
      const cosLat = Math.cos(lat);
      const sinLat = Math.sin(lat);
      const nLon = Math.max(12, Math.round(15 + 18 * Math.abs(cosLat)));
      for (let iLon = 0; iLon < nLon; iLon++) {
        // +x hemisphere only (LV)
        const lon = -Math.PI * 0.48 + ((iLon + 0.5) / nLon) * Math.PI * 0.96;
        const ux = cosLat * Math.cos(lon);
        if (ux < 0.08) continue;
        const uy = sinLat;
        const uz = cosLat * Math.sin(lon);
        for (const df of [0.4, 0.7]) {
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
    const nRho = 9;
    for (let ir = 0; ir < nRho; ir++) {
      const rho = 0.08 + (ir / Math.max(1, nRho - 1)) * 0.82;
      const nAng = Math.max(10, Math.round(10 + 20 * rho));
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
    for (let ia = 0; ia < 26; ia++) {
      const ang = ((ia + 0.5) / 26) * Math.PI * 2;
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

  // AV fibrous groove: sparse insulator dots on the plane (no arrows) + atrial
  // and ventricular vestibules so the field climbs all the way to the base.
  {
    const { center, radius, innerLimit, outerLimit } = FIELD_ELLIPSOID;
    const py = AV_JUNCTION.planeY;
    for (let i = 0; i < 36; i++) {
      const ang = ((i + 0.5) / 36) * Math.PI * 2;
      const ux = Math.cos(ang);
      const uz = Math.sin(ang);
      for (const df of [0.45, 0.78]) {
        const n2 = innerLimit + df * (outerLimit - innerLimit);
        const s = Math.sqrt(n2);
        let uy = (py - center.y) / (s * radius.y);
        if (Math.abs(uy) > 0.92) continue;
        const horiz = Math.sqrt(Math.max(0, 1 - uy * uy));
        const x = ux * horiz * s * radius.x;
        const z = uz * horiz * s * radius.z;
        if (inSeptum([x, py, z])) continue;
        // Exact plane → insulator dots (complete ring)
        pushFieldSample(x, py, z);
        // Ventricular basal vestibule just inferior (field fills up to the groove)
        const [vx, vy, vz] = projectOntoMyocardialShell([x, py - 0.14, z]);
        if (vy <= py - 0.06) pushFieldSample(vx, vy, vz);
        // Atrial basal ring just superior
        const [ax, ay, az] = projectOntoMyocardialShell([x, py + 0.12, z]);
        if (ay >= py + 0.04) pushFieldSample(ax, ay, az);
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
  const focusDistanceCache = new Map<string, Float32Array>();
  const distancesFromFocus = (pos: THREE.Vector3): Float32Array => {
    const key = `${pos.x.toFixed(4)},${pos.y.toFixed(4)},${pos.z.toFixed(4)}`;
    const hit = focusDistanceCache.get(key);
    if (hit) return hit;
    const values = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      values[i] = myocardialTravelDistance(pos, samples[i]!.pos);
    }
    focusDistanceCache.set(key, values);
    return values;
  };
  // Multi-beat PAC/PVC/AFib loops revisit a small set of seed configurations.
  // Retain those maps instead of rebuilding Dijkstra whenever the active beat changes.
  const activationMapCache = new Map<string, ActivationMapResult>();
  const ACTIVATION_MAP_CACHE_LIMIT = 10;

  const tmpSum = new THREE.Vector3();
  const tmpOrigin = new THREE.Vector3();
  const tmpToFront = new THREE.Vector3();
  const tmpOutward = new THREE.Vector3();
  const tmpPathDir = new THREE.Vector3();
  const tmpFieldAcc = new THREE.Vector3();
  const tmpContribDir = new THREE.Vector3();
  const tmpFocusDir = new THREE.Vector3();
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

/** Distal terminals — vectors may finish / tip-hold here */
function isTerminalSegment(id: SegmentId): boolean {
  return id === "purkinjeL" || id === "purkinjeR" || id === "avnrtSlow" || id === "avnrtFast";
}

/** Stable arrow slot: flutter is one ring; AVNRT keeps both limbs visible */
function pathwayVectorSlotKey(f: ActiveFront): string {
  if (f.id === "flutter") return "loop:flutter";
  // Slow and fast are different anatomic limbs — never collapse them into one arrow
  if (f.id === "avnrtSlow" || f.id === "avnrtFast") {
    return `avnrt:${f.id}:${f.reverse ? "r" : "a"}`;
  }
  return `${f.id}:${f.curveIndex ?? 0}:${f.reverse ? "r" : "a"}`;
}

/**
 * Pathway vectors follow conduction along the tract. Allow travel all the way to
 * the distal end — a new wavefront behind must not hide an unfinished front.
 */
function pathwayVectorVisible(f: ActiveFront): boolean {
  const p = Math.min(1, Math.max(0, f.progress));
  if (f.id === "flutter") {
    return !f.tipHold;
  }
  if (isTerminalSegment(f.id)) {
    // Skip only the proximal junction bead; tip-hold stays visible so the wave finishes
    return p >= 0.04;
  }
  // Intermediate tracts: soft skip of the proximal junction only
  if (p < 0.04) return false;
  return true;
}

  function updateBranchArrows(
    fronts: ActiveFront[],
    opts: { mark: CycleMark; finding: FindingId; mag: number },
  ) {
    // NSR-style idle: no pathway vectors on TP. AFib keeps atrial fronts live.
    if (
      opts.mark === "TP" &&
      opts.finding !== "afib" &&
      opts.finding !== "avnrtTypical" &&
      opts.finding !== "avnrtAtypical"
    ) {
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
      // Prefer actively mid-tract; never drop an unfinished limb for a newer one
      // on a different slot (slots are already per-limb / per-curve).
      const score = (f: ActiveFront) => {
        const p = Math.min(1, Math.max(0, f.progress));
        const mid = 1 - Math.abs(p - 0.5) * 2;
        // Prefer the one further along so handoffs don't reset to the proximal end
        return (f.tipHold ? 1 : 2) + mid + p;
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
      // Flutter: harder lerp so CTI limb handoffs read continuous; AVNRT limbs have own slots
      const lerpT = f.id === "flutter" ? 0.55 : wasDim ? 1 : 0.38;
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
    const pathwayHoldScale = Math.min(1, 0.86 / cycleSec);
    const liveSegments = new Set<SegmentId>();
    const liveGroups = new Set(groupsForMark(opts.mark));
    for (const b of branches) {
      if (lesions.has(b.id)) continue;
      const win = effectiveImpulseWindow(b, branches, lesions, b.curveIndex);
      if (!win) continue;
      // Grace past t1 so handoffs don't drop liveSegments and kill the field
      const hold =
        b.id === "purkinjeL" || b.id === "purkinjeR"
          ? 0.14
          : b.id === "avnrtSlow" ||
              b.id === "avnrtFast" ||
              b.id === "accessory" ||
              b.id === "accessoryR"
            ? 0.1
            : 0.06;
      if (t >= win.t0 && t <= win.t1 + hold * pathwayHoldScale) {
        liveSegments.add(b.id);
      }
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
    const isAvnrt =
      opts.finding === "avnrtTypical" || opts.finding === "avnrtAtypical";
    const isReentry = isAvrt || isAvnrt;
    const isPaced = opts.finding.startsWith("paced");
    const ventricularPaced = isPaced && opts.finding !== "pacedAtrial";
    const isVf = opts.finding === "vfCoarse" || opts.finding === "vfFine";
    const longCycle = (opts.cycleSec ?? 1) > 1.6;
    // AFib f-waves / CTI flutter never idle — keep atrial group eligible under every EKG mark
    if (isAfib || isFlutter) {
      liveGroups.add("atrial");
      liveSegments.add("internodal");
      liveSegments.add("myocardiumA");
      if (isFlutter) liveSegments.add("flutter");
    }
    // Reentry: keep loop + atrial groups eligible across QRS/ST/T (P-on-T / Kent echo)
    if (isAvnrt) {
      liveGroups.add("avnrt");
      liveGroups.add("atrial");
      liveGroups.add("pacemaker");
    }
    if (isAvrt) {
      liveGroups.add("accessory");
      liveGroups.add("atrial");
    }

    // Accessory pathway live → atrial field may cross the AV plane (Kent)
    // Only while Kent is actually firing — not for the entire AVRT finding.
    const accessoryLive =
      liveSegments.has("accessory") ||
      liveSegments.has("accessoryR") ||
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
      reverse: boolean;
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
        reverse: !!f.reverse,
      });
    }
    const liveHisFront = fieldFronts.find((f) => f.id === "his");
    /** Kent front has reached / is traveling on the atrial side of the AV plane. */
    const kentAtrialFronts = fieldFronts.filter((f) => {
      if (f.id !== "accessory" && f.id !== "accessoryR") return false;
      // Orthodromic reverse: purple climbs with the front (mitral groove → atrium)
      if (f.reverse) return f.progress > 0.22;
      // Antidromic atrial corridor / valve-plane return
      return f.pos.y >= AV_JUNCTION.planeY - 0.18;
    });
    let kentAtrialProgress = 0;
    for (const f of kentAtrialFronts) {
      const p = f.reverse ? Math.max(0, (f.progress - 0.22) / 0.78) : Math.min(1, f.progress);
      if (p > kentAtrialProgress) kentAtrialProgress = p;
    }
    // Schedule fallback: EKG may flip to TP while Kent is still mid-atrium — keep the
    // purple atrial shell alive from the limb window even if fronts briefly drop.
    let kentSchedAtrial = false;
    for (const b of branches) {
      if (b.id !== "accessory" && b.id !== "accessoryR") continue;
      if (!b.reverse && !(opts.finding.startsWith("avrtAnti") && b.t0 >= 0.55)) continue;
      const win = effectiveImpulseWindow(b, branches, lesions, b.curveIndex);
      if (!win) continue;
      const hold = 0.22;
      if (t < win.t0 + 0.08 * (win.t1 - win.t0) || t > win.t1 + hold) continue;
      const span = Math.max(1e-4, win.t1 - win.t0);
      const prog = Math.min(1, Math.max(0, (t - win.t0) / span));
      const atrialProg = b.reverse
        ? Math.max(0, (prog - 0.22) / 0.78)
        : Math.min(1, Math.max(0, (prog - 0.05) / 0.95));
      if (atrialProg > 0) {
        kentSchedAtrial = true;
        if (atrialProg > kentAtrialProgress) kentAtrialProgress = atrialProg;
      }
    }
    const kentAtrialEngage = kentAtrialFronts.length > 0 || kentSchedAtrial;
    // Let atrial field samples stay eligible while Kent is activating atrium
    if (isAvrt && kentAtrialEngage) liveGroups.add("atrial");

    const kentSide = avrtKentSide(opts.finding);
    const kentAtrialOrigin = kentSide
      ? new THREE.Vector3(...KENT_ATRIAL_INSERT[kentSide])
      : null;
    const kentPurpleId: SegmentId =
      kentSide === "right" ? "accessoryR" : "accessory";
    const kentPurpleHex = SEGMENT_FIELD_COLOR[kentPurpleId] ?? 0xc070ff;

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
      let bestWin: { t0: number; t1: number } | null = null;
      let bestScore = -Infinity;
      for (const b of list) {
        const win = effectiveImpulseWindow(b, branches, lesions, b.curveIndex);
        if (!win) continue;
        let score: number;
        if (t >= win.t0 && t <= win.t1 + tipHoldMeta) score = 2000 + win.t0;
        else if (t < win.t0) score = 1000 - (win.t0 - t);
        else score = 500 - (t - win.t1);
        if (score > bestScore) {
          bestScore = score;
          best = b;
          bestWin = win;
        }
      }
      if (!best || !bestWin) continue;
      const reverse = !!best.reverse || (best.u0 != null && best.u1 != null && best.u1 < best.u0);
      liveMeta.set(id, {
        group: best.group,
        t0: bestWin.t0,
        t1: bestWin.t1,
        reverse,
      });
    }

    // Stable LAT seed span per segment: earliest→latest effective window so the
    // myocardial field always finishes filling even after a later reentry limb starts.
    const seedMeta = new Map<SegmentId, { t0: number; t1: number }>();
    for (const [id, list] of bySeg) {
      const ante = list.filter((b) => !b.reverse);
      const use = ante.length ? ante : list;
      let t0 = Infinity;
      let t1 = -Infinity;
      for (const b of use) {
        const win = effectiveImpulseWindow(b, branches, lesions, b.curveIndex);
        if (!win) continue;
        t0 = Math.min(t0, win.t0);
        t1 = Math.max(t1, win.t1);
      }
      if (t0 < Infinity) seedMeta.set(id, { t0, t1 });
    }

    // lesions already computed above for liveSegments gating
    // LAT map + myocardial Dijkstra handle delay into blocked territory — no additive lag
    const isRepol = opts.mark === "T" || opts.mark === "ST";
    /** Reentry limbs still traveling — do not snap the field to repol mid-circuit. */
    const reentryLive = fieldFronts.some(
      (f) =>
        f.id === "accessory" ||
        f.id === "accessoryR" ||
        f.id === "avnrtSlow" ||
        f.id === "avnrtFast" ||
        (f.reverse &&
          (f.id === "internodal" || f.id === "sa" || f.id === "av" || f.id === "his")),
    );
    /**
     * Local recovery envelopes once tissue has activated. This is NOT a hard global
     * cut of the depol field — each sample crossfades when its own recovery arrives.
     * Reentry limbs still traveling: don't force mid-circuit grey wipe.
     */
    const allowLocalRepol = !reentryLive;
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
      distances: Float32Array;
    };
    const liveFoci: LiveFocus[] = foci.map((f) => {
      const since = fieldAge(t, f.t0 ?? 0.22, longCycle);
      const waveDur = f.waveDur ?? (opts.finding === "pvc" ? 0.38 : 0.55);
      const fireDur = f.fireDur ?? 0.14;
      const pos = new THREE.Vector3(...f.pos);
      return {
        pos,
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
        distances: distancesFromFocus(pos),
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
    if (isVf) {
      const period = opts.finding === "vfFine" ? 0.075 : 0.14;
      for (let i = 0; i < liveFoci.length; i++) {
        const f = liveFoci[i]!;
        const phase = ((t - i * period * 0.37) % period + period) % period;
        f.since = phase;
        f.t0 = t - phase;
        f.waveActive = true;
        f.firing = phase < period * 0.28;
        f.waveDur = period * 1.35;
      }
    }
    const hasActiveAtrialFocus = liveFoci.some(
      (f) => f.waveActive && f.tissue === "atrial",
    );

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
    // With both sides intact, use one causal Purkinje seed window so the broad
    // LV/RV myocardial fields rise together. The shared start is the later
    // junction handoff, so synchronization can never move either side early.
    const leftPurkMeta =
      liveMeta.get("purkinjeL") ?? seedMeta.get("purkinjeL") ?? branchMeta.get("purkinjeL");
    const rightPurkMeta =
      liveMeta.get("purkinjeR") ?? seedMeta.get("purkinjeR") ?? branchMeta.get("purkinjeR");
    const sharedPurkWindow =
      !leftComplete && !rightComplete && leftPurkMeta && rightPurkMeta
        ? {
            t0: Math.max(leftPurkMeta.t0, rightPurkMeta.t0),
            t1: Math.max(leftPurkMeta.t1, rightPurkMeta.t1),
          }
        : null;
    const scheduledWholeSegment = new Set<SegmentId>();
    const scheduledCurve = new Set<string>();
    for (const branch of branches) {
      if (branch.curveIndex == null) scheduledWholeSegment.add(branch.id);
      else scheduledCurve.add(`${branch.id}:${branch.curveIndex}`);
    }

    for (let pi = 0; pi < probes.length; pi++) {
      const pr = probes[pi]!;
      const id = pr.segmentId;
      const isPurk = id === "purkinjeL" || id === "purkinjeR";
      if (!isPurk) continue;
      if (
        ventricularPaced ||
        opts.finding === "av3" ||
        opts.finding === "vfCoarse" ||
        opts.finding === "vfFine"
      ) {
        continue;
      }
      if (lesions.has(id)) continue;
      // Myocardial vectors begin at Purkinje exits, not while the impulse ball is
      // still traversing His/bundle tissue. Bundle fronts remain visible on their
      // conduction paths but cannot seed the ventricular shell ahead of a junction.
      // Keep dense left exits and enough right exits for an even RV wave.
      if (id === "purkinjeR" && pi % 2 !== 0) continue;
      const ci = pr.curveIndex ?? 0;
      if (
        !scheduledWholeSegment.has(id) &&
        !scheduledCurve.has(`${id}:${ci}`)
      ) {
        continue;
      }

      if (leftComplete && rightComplete) continue; // trifascicular — ectopy only

      // Field colors = conduction-branch origin. Balls race the HPS first; field seeds
      // fire slightly after the tip so arrows trail in that branch's color.
      if (leftComplete) {
        // LBBB: only distal right Purkinje exits seed myocardial fill.
        if (id !== "purkinjeR" || pr.pos[0]! > -0.28 || pr.pathU < 0.55) {
          continue;
        }
      } else if (rightComplete) {
        // RBBB: only intact left Purkinje exits seed myocardial fill.
        if (id !== "purkinjeL") continue;
        if (lafOnly && PURKINJE_L_LAF_CURVES.has(ci)) continue;
        if (lpfOnly && PURKINJE_L_LPF_CURVES.has(ci)) continue;
        // Septal fascicle lives near midline — don't require free-wall x.
        if (PURKINJE_L_SEPTAL_CURVES.has(ci)) {
          if (pr.pathU < 0.22) continue;
        } else if (pr.pos[0]! < 0.12 || pr.pathU < 0.28) {
          continue;
        }
      } else {
        // NSR / fascicular block: each intact Purkinje tree seeds after handoff.
        if (id === "purkinjeL") {
          if (lafOnly && PURKINJE_L_LAF_CURVES.has(ci)) continue;
          if (lpfOnly && PURKINJE_L_LPF_CURVES.has(ci)) continue;
          if (pr.pathU < 0.22) continue;
        } else if (pr.pathU < 0.25 || pr.pos[0]! > 0.02) {
          continue;
        }
      }

      const meta = liveMeta.get(id) ?? seedMeta.get(id) ?? branchMeta.get(id);
      if (!meta) continue;
      const seedWindow = sharedPurkWindow ?? meta;
      const span = Math.max(0.01, seedWindow.t1 - seedWindow.t0);
      // Intact NSR: identical tip lag on L/R so both HPS exits claim myocardium together
      const tipLag = 0.002;
      let t0 = seedWindow.t0 + pr.pathU * span + tipLag;
      // Keep the effective live window: it includes the upstream junction gate.
      // Replacing it with the nominal NSR window let Purkinje LAT start before
      // the RBB/LBB impulse ball had physically reached the takeoff.
      mapSeeds.push({
        pos: pr.pos,
        t0,
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

    // BBB: slower myocardial fill so the intact → blocked wavefront stays readable
    const myoSpeed =
      leftComplete || rightComplete ? 0.14 : lesions.size ? 0.09 : 0.01;
    const mapKey = activationSeedKey(
      mapSeeds,
      opts.lesionIds,
      myoSpeed,
      blockedChamber,
      blockedFascicle,
    );
    let actMap = activationMapCache.get(mapKey);
    if (!actMap) {
      actMap = buildActivationMap({
        samples: sampleInputs,
        seeds: mapSeeds,
        lesionIds: opts.lesionIds,
        myoSpeed,
        blockedChamber,
        blockedFascicle,
        graph: activationGraph,
      });
      // Force ventricular LAT into the EKG QRS window so the large QRS deflection
      // and the myocardial vector field share one timeline (order preserved).
      // Intact NSR: L and R depolarize/recover together on the QRS/T windows.
      // Complete BBB: keep global remap so the blocked chamber stays delayed.
      // Multi-beat / irregular (AFib, flutter, Wenckebach, …): keep absolute
      // branch-timed LATs — remapping onto a fixed NSR QRS kills every other beat.
      const syncChambers = !leftComplete && !rightComplete;
      if (findingUsesFixedQrsAlign(opts.finding)) {
        alignVentricularLatToQrs(actMap, opts.finding, sampleInputs, syncChambers);
        alignVentricularRecoveryToT(actMap, opts.finding, sampleInputs, syncChambers);
      }
      activationMapCache.set(mapKey, actMap);
      if (activationMapCache.size > ACTIVATION_MAP_CACHE_LIMIT) {
        const oldest = activationMapCache.keys().next().value as string | undefined;
        if (oldest) activationMapCache.delete(oldest);
      }
    } else {
      // Refresh LRU order.
      activationMapCache.delete(mapKey);
      activationMapCache.set(mapKey, actMap);
    }
    lastQrsFrac = actMap.qrsFrac;

    // Impulse fronts drive the resultant whenever they are live — including retrograde
    // atrial / Kent limbs that the EKG marks as ST or T (P-on-T). Pure myocardial
    // recovery (no fronts) falls through to ± QRS axis below.
    if (meanGroup.visible && !!opts.fronts?.length && opts.mark !== "TP") {
      const fronts = opts.fronts!;
      const hasReverse = fronts.some((f) => f.reverse);
      for (const f of fronts) {
        // Retrograde atrial echo should dominate the mean axis, but ventricular
        // anterograde fronts must still finish — don't zero them the instant
        // a reverse limb lights (physiologically both coexist).
        if (
          hasReverse &&
          !f.reverse &&
          (f.id === "sa" || f.id === "internodal" || f.id === "myocardiumA")
        ) {
          continue;
        }
        tmpOutward.set(f.dir[0]!, f.dir[1]!, f.dir[2]!);
        if (tmpOutward.lengthSq() < 1e-8) continue;
        tmpOutward.normalize();
        const p = Math.min(1, Math.max(0, f.progress));
        const envelope = p < 0.12 ? p / 0.12 : 1;
        const retroBoost = f.reverse ? 1.35 : hasReverse ? 0.85 : 1;
        const w = (0.35 + 0.65 * envelope) * frontMass(f.id) * retroBoost;
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
        // Fibrous plane = insulator: grey dots only (no current → no arrows)
        s.arrow.visible = false;
        s.ball.visible = true;
        s.ball.position.copy(s.pos);
        s.ball.scale.setScalar(0.55);
        const bm = s.ball.material;
        if (bm instanceof THREE.MeshBasicMaterial) {
          bm.color.setHex(0x9aa4ae);
          bm.opacity = 0.4;
        }
        s.glow = 0;
        continue;
      }
      const hisWaveLocal =
        !!liveHisFront &&
        s.pos.distanceToSquared(liveHisFront.pos) < 0.34 * 0.34;

      // Blocked free-wall territory stays dark until myocardial LAT arrives —
      // including on ST/T. Never show grey recovery on tissue that has not
      // depolarized yet. Isolated LAFB/LPFB: true septum is NOT blocked — the
      // septal Purkinje fiber remains intact whenever the main LBB is up.
      // Allow a short crest lead-in so the traveling front is visible as it arrives.
      const septalSample = inSeptum(s.pos);
      const awaitingBlockFill =
        s.tissue === "ventricular" &&
        ((blockedChamber === "left" && s.pos.x > 0.04) ||
          (blockedChamber === "right" && s.pos.x < -0.04) ||
          (blockedFascicle === "laf" &&
            !septalSample &&
            s.pos.x > 0.12 &&
            s.pos.z > -0.05 &&
            s.pos.y > -1.08) ||
          (blockedFascicle === "lpf" &&
            !septalSample &&
            s.pos.x > 0.1 &&
            s.pos.z < -0.12 &&
            s.pos.y < -0.35));
      if (awaitingBlockFill && mapSt.lat >= 1e8) {
        s.arrow.visible = false;
        s.ball.visible = false;
        s.glow = 0;
        continue;
      }
      if (awaitingBlockFill && t + 0.035 < mapSt.lat) {
        s.arrow.visible = false;
        s.ball.visible = false;
        s.glow = 0;
        continue;
      }

      // Prefer pathway timing for atria; LAT map is ventricular HPS.
      // Blocked tracts never contribute pathway actTime — myocardium fills from intact seeds.
      // Fascicular block: free-wall Purkinje of the blocked fascicle is mute; septum /
      // septal Purkinje keep pathway timing when LBB itself is intact.
      const blockTerritory =
        lesions.has(s.nearestId) ||
        (leftComplete && !rightComplete && s.pos.x > 0.02) ||
        (rightComplete && !leftComplete && s.pos.x < -0.02) ||
        (lafOnly &&
          (s.nearestId === "lbba" ||
            (s.nearestId === "purkinjeL" &&
              !septalSample &&
              s.pos.z > -0.08 &&
              s.pos.x < 0.62))) ||
        (lpfOnly &&
          (s.nearestId === "lbbp" ||
            (s.nearestId === "purkinjeL" && !septalSample && s.pos.z < -0.15)));

      let act =
        s.tissue === "atrial" || mapSt.lat >= 1e8 ? s.actTime : mapSt.lat;
      const lmLive = blockTerritory ? undefined : liveMeta.get(s.nearestId);
      if (lmLive) {
        const uFrac = lmLive.reverse ? 1 - s.pathU : s.pathU;
        const pathAct = lmLive.t0 + uFrac * (lmLive.t1 - lmLive.t0);
        if (s.tissue === "atrial") {
          act = pathAct;
        } else if (
          (s.nearestId === "accessory" || s.nearestId === "accessoryR") &&
          mapSt.lat < 1e8
        ) {
          // Kent hugs LV endocardium — many free-wall samples are "nearest" to
          // accessory. Keep myocardial LAT for ventricular fill; don't let
          // retrograde Kent path timing age those samples off early.
          act = mapSt.lat;
        } else if (s.pathDist < 0.11) {
          // On the fiber corridor only: droplet can track the ball tip
          act = Math.min(mapSt.lat < 1e8 ? mapSt.lat : pathAct, pathAct);
        } else if (mapSt.lat < 1e8) {
          // Free-wall myocardium: NEVER light from pathway time ahead of LAT
          act = mapSt.lat;
        }
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
        const dFocus = focus.distances[si]!;

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
              focusDir = tmpFocusDir.copy(mapSt.depolDir);
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
        const fieldAct = preExT0 + dFocus * 0.58;
        // Thin traveling shell — not a long diffuse fill of random arrows
        if (
          fieldAct <= preExT1 + 0.16 &&
          Math.abs(t - fieldAct) < 0.12 &&
          (!lmLive || fieldAct <= act + 0.06 || s.nearestId === "accessory" || s.nearestId === "accessoryR")
        ) {
          act = Math.min(act, fieldAct);
          fromMyoFocus = true;
          focusTissue = "ventricular";
          focusColor = preExColor;
          focusLocalAge = t - fieldAct;
          shellReached = true;
          if (mapSt.depolDir.lengthSq() > 1e-10 && mapSt.lat < 1e8) {
            focusDir = tmpFocusDir.copy(mapSt.depolDir);
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
          hisWaveLocal ||
          (((s.nearestId === "av" || s.nearestId === "his") || hisWaveLocal) &&
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
        // Dual-chamber / atrial pace: finish atrial capture field into early QRS
        if (
          isPaced &&
          s.tissue === "atrial" &&
          fromMyoFocus &&
          focusTissue === "atrial"
        ) {
          chamberOk = true;
        }
        // AVRT: show field crossing the fibrous plane along the Kent insertion
        if (accessoryLive && nearKentAvCross(s.pos, s.nearestId)) chamberOk = true;
        // Kent atrial phase: open the atrial shell so the field can propagate
        if (
          isAvrt &&
          s.tissue === "atrial" &&
          (kentAtrialEngage ||
            (accessoryLive &&
              (liveMeta.get("accessory")?.reverse || liveMeta.get("accessoryR")?.reverse)))
        ) {
          chamberOk = true;
        }
        // AVNRT: retrograde atrial echo rides on QRS/ST/T — keep atrium open while the loop is live
        if (
          isAvnrt &&
          s.tissue === "atrial" &&
          (liveSegments.has("avnrtSlow") ||
            liveSegments.has("avnrtFast") ||
            liveSegments.has("internodal") ||
            liveSegments.has("sa") ||
            reentryLive)
        ) {
          chamberOk = true;
        }
        // Dual-pathway / Kent corridor samples near the node
        if (
          isAvnrt &&
          (s.nearestId === "avnrtSlow" ||
            s.nearestId === "avnrtFast" ||
            s.nearestId === "av" ||
            nearHisPenetration(s.pos))
        ) {
          chamberOk = true;
        }
      } else if (opts.mark === "TP") {
        chamberOk = (isAfib || isFlutter) && s.tissue === "atrial";
        // AVRT: retrograde atrial echo often lands on a TP-labeled phase — keep atrium
        // + Kent corridor lit while the purple wave is still spreading.
        if (
          isAvrt &&
          (kentAtrialEngage ||
            accessoryLive ||
            liveMeta.get("accessory")?.reverse ||
            liveMeta.get("accessoryR")?.reverse) &&
          (s.tissue === "atrial" ||
            s.nearestId === "accessory" ||
            s.nearestId === "accessoryR" ||
            nearKentAvCross(s.pos, s.nearestId))
        ) {
          chamberOk = true;
        }
        if (
          isAvnrt &&
          s.tissue === "atrial" &&
          (liveSegments.has("avnrtSlow") ||
            liveSegments.has("avnrtFast") ||
            liveSegments.has("internodal") ||
            reentryLive)
        ) {
          chamberOk = true;
        }
      }
      if (
        (opts.finding === "avrtAntiLeft" ||
          opts.finding === "avrtAntiRight" ||
          opts.finding === "avrtOrthoLeft" ||
          opts.finding === "avrtOrthoRight") &&
        (opts.mark === "P" || opts.mark === "PR") &&
        (s.tissue === "atrial" ||
          s.nearestId === "accessory" ||
          s.nearestId === "accessoryR" ||
          nearKentAvCross(s.pos, s.nearestId) ||
          (opts.finding.startsWith("avrtAnti") && s.tissue === "ventricular"))
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
      } else if (!isAvrt && fromMyoFocus && focusTissue === "atrial") {
        // PAC / AFib / atrial pace — AV-plane rule (accessory / AV corridor exceptions)
        chamberOk = atrialSourceMayDriveSample(
          s.pos,
          s.tissue,
          s.nearestId,
          accessoryLive,
          avNodeLive,
        );
      } else if (!isAvrt && fromMyoFocus) {
        chamberOk = s.tissue === "ventricular" || s.nearestId === "accessory" || s.nearestId === "accessoryR";
      }

      // —— Local field = superposition of concurrent conduction activities ——
      // Magnitude / direction = vector sum; color = discrete dominant source.
      // As each activity fades, magnitude decays smoothly (no hard cut-off).
      const blockSideSample =
        (blockedChamber === "left" && s.pos.x > 0.04) ||
        (blockedChamber === "right" && s.pos.x < -0.04) ||
        (blockedFascicle === "laf" && !inSeptum(s.pos) && s.pos.x > 0.12 && s.pos.z > -0.05) ||
        (blockedFascicle === "lpf" && !inSeptum(s.pos) && s.pos.x > 0.1 && s.pos.z < -0.12);

      // Ventricular: use map LAT + remapped recovery so L/R grey crest together on T.
      // Free-wall myocardium with no map LAT must stay unactivated (no pathway fallback
      // that would invent a recovery clock on blocked tissue).
      const lat =
        fromMyoFocus
          ? act
          : s.tissue === "atrial" || opts.mark === "P" || (opts.mark === "PR" && s.tissue !== "ventricular")
            ? act
            : mapSt && mapSt.lat < 1e8
              ? s.tissue === "ventricular"
                ? mapSt.lat
                : s.pathDist < 0.11
                  ? Math.min(mapSt.lat, act)
                  : mapSt.lat
              : s.tissue === "ventricular"
                ? 1e9
                : act;
      const apdLocal =
        mapSt && mapSt.apd > 0
          ? mapSt.apd
          : s.tissue === "atrial"
            ? 0.16
            : 0.27;
      const recovery =
        s.tissue === "ventricular"
          ? mapSt && mapSt.recovery < 1e8 && lat < 1e8
            ? mapSt.recovery
            : 1e9
          : lat < 1e8
            ? lat + apdLocal
            : act + apdLocal;
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

      // Local recovery — only after this sample has actually depolarized.
      // Never grey-out tissue that is still waiting on LAT (esp. BBB blocked fill).
      const repolAgeLocal = fieldAge(t, recovery, longCycle);
      const hasDepolarized =
        lat < 1e8 &&
        recovery < 1e8 &&
        Number.isFinite(depolAge) &&
        t >= lat - 0.005 &&
        delayedAge > 0 &&
        recovery > lat + 0.04;
      const localRepol =
        allowLocalRepol && hasDepolarized && repolAgeLocal > -0.04
          ? recoveryEnvelope(repolAgeLocal)
          : 0;
      // Soft crossfade — depol / plateau linger while recovery rises (no hard cut)
      const depolMute = localRepol > 0.02 ? Math.max(0, 1 - localRepol * 0.85) : 1;
      const apdSpanLocal = Math.max(0.04, recovery - lat);
      const inRefractory =
        hasDepolarized &&
        t < recovery &&
        localRepol < 0.1 &&
        delayedAge > 0.04;

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
        // AVRT: mute sinus / Bachmann — Kent fronts own the retrograde atrium
        const muteBachmann = isAvrt && accessoryLive && (wantAtrial || nearKentAvCross(s.pos, s.nearestId));
        for (const f of fieldFronts) {
          const frontIsAtrial = f.atrial || isAtrialFrontId(f.id);
          const isAccessoryFront = f.id === "accessory" || f.id === "accessoryR";
          const accReverse = isAccessoryFront && f.reverse;
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
          const accIntoAtrium = isAccessoryFront && wantAtrial && (accReverse || kentAtrialEngage);
          const onKentCorridor =
            isAccessoryFront &&
            (nearKentAvCross(s.pos, s.nearestId) ||
              s.nearestId === "accessory" ||
              s.nearestId === "accessoryR");
          // AVRT: wide purple wake along the whole Kent tube (not a thin tip speck)
          const accLatMax = accIntoAtrium
            ? 0.9
            : isAvrt
              ? onKentCorridor
                ? 0.58
                : 0.36
              : accReverse
                ? 0.24
                : 0.18;
          if (
            isAccessoryFront &&
            !wantAtrial &&
            !onKentCorridor &&
            latD > accLatMax
          ) {
            continue;
          }
          if (
            isAccessoryFront &&
            wantAtrial &&
            !accIntoAtrium &&
            latD > (isAvrt ? 0.45 : 0.28)
          ) {
            continue;
          }
          const leftHps = isLeftHpsId(f.id);
          const rightHps = isRightHpsId(f.id);
          // Paced myocardial color remains owned by the lead. Reverse HPS
          // recruitment may still show on the conduction anatomy, but must not
          // repaint the ventricular field blue/green after the paced QRS.
          if (ventricularPaced && !wantAtrial && (leftHps || rightHps)) continue;
          const lead = accIntoAtrium
            ? 0.28
            : wantAtrial
              ? flutterFront
                ? 0.14
                : 0.1
              : isAccessoryFront
                ? isAvrt
                  ? 0.22
                  : accReverse
                    ? 0.14
                    : 0.12
                : leftHps || rightHps
                  ? 0.12
                  : 0.08;
          // Pathway droplet: corridor around the tip. Both HPS sides similar caliber;
          // chamber-locked so green/blue don't paint the opposite free wall early.
          if ((leftHps || rightHps) && !wantAtrial) {
            // Hard chamber lock — blue never paints LV free wall; green never paints RV
            if (leftHps && s.pos.x < -0.05) continue;
            if (rightHps && s.pos.x > -0.02) continue;
            // Never paint ahead of the tip along the tract
            if (along > 0.1) continue;
            // The moving conduction ball emits a local wave into nearby ventricular
            // tissue. The along/latD limits keep this attached to the ball rather
            // than allowing the myocardial shell to activate distally ahead of it.
            if (lat >= 1e8) continue;
          }
          const wake = accIntoAtrium
            ? 0.75 + 0.35 * kentAtrialProgress
            : wantAtrial
              ? flutterFront
                ? 0.42
                : 0.28
              : isAccessoryFront
                ? isAvrt
                  ? 0.72
                  : accReverse
                    ? 0.4
                    : 0.28
                : leftHps || rightHps
                  ? 0.2
                  : 0.22;
          const sigma = accIntoAtrium
            ? 0.3 + 0.32 * kentAtrialProgress
            : wantAtrial
              ? flutterFront
                ? 0.18
                : 0.12
              : isAccessoryFront
                ? isAvrt
                  ? onKentCorridor
                    ? 0.28
                    : 0.2
                  : accReverse
                    ? 0.16
                    : 0.12
                : leftHps || rightHps
                  ? 0.14
                  : 0.12;
          if (along > lead || along < -wake || latD > sigma * 2.8) continue;
          const alongW =
            along >= 0
              ? Math.exp(-(along * along) / (2 * lead * lead * 0.55))
              : Math.exp(along / (wake * 0.55));
          const latW = Math.exp(-(latD * latD) / (2 * sigma * sigma));
          const prog = 0.55 + 0.45 * Math.min(1, Math.max(0, f.progress));
          const sourceScale =
            leftHps || rightHps
              ? 1.15
              : frontMass(f.id) * hpsFieldBalance(f.id);
          const w =
            alongW *
            latW *
            prog *
            sourceScale *
            (flutterFront
              ? 1.35
              : accIntoAtrium
                ? 1.65 + 0.35 * kentAtrialProgress
                : isAccessoryFront && isAvrt
                  ? 1.85
                  : accReverse
                    ? 1.45
                    : isAccessoryFront
                      ? 1.3
                      : 1);
          // Free-wall myocardium: pathway fronts are a weak local force — the LAT
          // shell grid owns the organized resultant (avoids arrow soup).
          const frontW =
            s.tissue === "ventricular" && !isAccessoryFront && s.pathDist > 0.09
              ? w * (leftHps || rightHps ? 0.5 : 0.2)
              : w;
          frontIntensity = Math.max(frontIntensity, frontW);
          // AVRT: accessory fronts always paint Kent purple
          const frontColor = isAccessoryFront
            ? SEGMENT_FIELD_COLOR[f.id] ?? 0xc070ff
            : chamberLockedFieldColor(s.pos, f.color, f.id, blockedChamber);
          // Prefer the traveling Kent tangent — don't lerp toward stale nearest-path noise
          tmpContribDir.copy(f.dir).lerp(s.dir, isAccessoryFront ? 0.04 : 0.18);
          projectOntoShellTangent(tmpContribDir, s.pos);
          if (s.tissue === "ventricular" && !isAccessoryFront) {
            biasVentricularApexward(tmpContribDir, s.pos);
            projectOntoShellTangent(tmpContribDir, s.pos);
          }
          // Atrial front dirs cannot aim across the plane outside His gap / accessory
          if (frontIsAtrial && !(accessoryLive && nearKentAvCross(s.pos, s.nearestId))) {
            clampDirToAvPlane(s.pos, tmpContribDir, true);
          }
          if (accIntoAtrium) clampDirToAvPlane(s.pos, tmpContribDir, true);
          addContrib(frontW * depolMute, tmpContribDir, frontColor);
        }
      }

      // His is short and lies inside the fibrous penetration corridor, where the
      // generic shell wake has few samples. Give the moving His ball a compact,
      // explicit red emitter so the pre-bifurcation ventricular vector is visible.
      if (chamberOk && liveHisFront && hisWaveLocal && depolMute > 0.04) {
        const d = s.pos.distanceTo(liveHisFront.pos);
        const edge = Math.max(0, 1 - d / 0.28);
        const w = edge * edge * 1.3 * depolMute;
        if (w > 0.012) {
          setHisPropagationDir(tmpContribDir, s.pos, liveHisFront.pos);
          addContrib(w, tmpContribDir, SEGMENT_FIELD_COLOR.his ?? 0xff5e6c);
          frontIntensity = Math.max(frontIntensity, w);
        }
      }

      // AVRT: coherent purple tube field around the live Kent front (fills gaps the
      // anisotropic wake can miss on the lowered mitral-groove path).
      if (chamberOk && isAvrt && reentryLive) {
        for (const f of fieldFronts) {
          if (f.id !== "accessory" && f.id !== "accessoryR") continue;
          const d = s.pos.distanceTo(f.pos);
          const tubeR = 0.2 + 0.16 * Math.min(1, f.progress);
          if (d > tubeR) continue;
          if (
            !nearKentAvCross(s.pos, s.nearestId) &&
            s.nearestId !== "accessory" &&
            s.nearestId !== "accessoryR" &&
            d > tubeR * 0.65
          ) {
            continue;
          }
          const edge = Math.max(0, 1 - d / tubeR);
          const w = edge * edge * (0.85 + 0.55 * f.progress) * frontMass(f.id) * depolMute;
          if (w < 0.03) continue;
          tmpContribDir.copy(f.dir);
          if (tmpContribDir.lengthSq() < 1e-10) continue;
          projectOntoShellTangent(tmpContribDir, s.pos);
          const col = SEGMENT_FIELD_COLOR[f.id] ?? 0xc070ff;
          addContrib(w, tmpContribDir, col);
          frontIntensity = Math.max(frontIntensity, w);
        }
      }

      // AVRT: expanding atrial shell from the Kent atrial insertion (not only the
      // pathway tip, which races on toward AV and would leave atrium dark).
      if (chamberOk && isAvrt && kentAtrialEngage && s.tissue === "atrial" && reentryLive) {
        const origins: THREE.Vector3[] = [];
        if (kentAtrialOrigin) origins.push(kentAtrialOrigin);
        for (const f of kentAtrialFronts) origins.push(f.pos);
        if (!origins.length && kentAtrialOrigin) origins.push(kentAtrialOrigin);
        // Thin traveling ring from the insert — grows with VA progress
        const radius = 0.16 + 0.78 * kentAtrialProgress;
        const ringW = 0.11 + 0.04 * kentAtrialProgress;
        let bestShell = 0;
        for (const origin of origins) {
          const d = s.pos.distanceTo(origin);
          if (d > radius + ringW) continue;
          // Prefer the expanding ring; keep a soft fill inside so purple doesn't blink off
          const ahead = d - radius;
          const ring =
            ahead > 0
              ? Math.exp(-(ahead * ahead) / (2 * ringW * ringW))
              : Math.exp(-(ahead * ahead) / (2 * (ringW * 1.6) * (ringW * 1.6))) * 0.55;
          if (ring > bestShell) {
            bestShell = ring;
            tmpOutward.copy(s.pos).sub(origin);
          }
        }
        const w = bestShell * (0.55 + 1.15 * kentAtrialProgress) * frontMass(kentPurpleId);
        if (w > 0.02 && tmpOutward.lengthSq() > 1e-10) {
          tmpContribDir.copy(tmpOutward);
          projectOntoShellTangent(tmpContribDir, s.pos);
          clampDirToAvPlane(s.pos, tmpContribDir, true);
          addContrib(w, tmpContribDir, kentPurpleHex);
          frontIntensity = Math.max(frontIntensity, w);
        }
      }

      // 2) Myocardial activation wavefront — ripples out from conduction exits / foci
      // along the LAT map (thin traveling ring; dark ahead of local LAT).
      if (
        chamberOk &&
        depolMute > 0.04 &&
        s.tissue === "ventricular" &&
        mapSt &&
        mapSt.lat < 1e8 &&
        delayedAge >= -0.02
      ) {
        const localPvc =
          fromMyoFocus && focusTissue === "ventricular" && shellReached
            ? Math.min(1, Math.max(0, 1 - focusLocalAge * 4))
            : 0;
        // Thin droplet crest — same both sides; no early free-wall fill
        const waveW = blockTerritory
          ? 0.09
          : leftComplete || rightComplete
            ? 0.075
            : isReentry
              ? 0.058
              : 0.05;
        const env = activationWavefront(delayedAge, waveW) * (1 - 0.85 * localPvc);
        const fiber =
          mapSt.originSegmentId != null ? frontMass(mapSt.originSegmentId) : frontMass(s.nearestId);
        const sideBal = hpsFieldBalance(mapSt.originSegmentId ?? s.nearestId);
        // Live pathway fronts (Kent / HPS balls) stay dominant on their corridor;
        // myocardium carries the expanding shell elsewhere.
        const myoScale =
          isAvrt && frontIntensity > 0.18 ? 0.32 : frontIntensity > 0.35 ? 0.55 : 1;
        const myoW = env * (blockTerritory ? 1.1 : 1) * fiber * sideBal * myoScale * depolMute;
        if (myoW > 0.015) {
          // Direction = LAT gradient toward later tissue (the traveling front itself)
          if (mapSt.depolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.depolDir);
          else tmpContribDir.copy(s.dir);
          if (tmpContribDir.lengthSq() > 1e-10) tmpContribDir.normalize();
          projectOntoShellTangent(tmpContribDir, s.pos);
          biasVentricularApexward(tmpContribDir, s.pos);
          // BBB teaching: gentle bias across the septum without remixing the front
          if (leftComplete && !rightComplete && s.pos.x > -0.08) {
            tmpContribDir.x += 0.35;
            if (tmpContribDir.lengthSq() > 1e-10) tmpContribDir.normalize();
          } else if (rightComplete && !leftComplete && s.pos.x < 0.08) {
            tmpContribDir.x -= 0.35;
            if (tmpContribDir.lengthSq() > 1e-10) tmpContribDir.normalize();
          }
          projectOntoShellTangent(tmpContribDir, s.pos);
          const originHex = chamberLockedFieldColor(
            s.pos,
            mapSt.originColor || SEGMENT_FIELD_COLOR[mapSt.originSegmentId!] || s.nearestColor,
            mapSt.originSegmentId,
            blockedChamber,
          );
          // NSR only: don't let contralateral origin paint free wall.
          // BBB: intact-side origin MUST paint the blocked chamber as it fills.
          const wrongChamberMyo =
            !blockedChamber &&
            ((!inSeptum(s.pos) &&
              s.pos.x > 0.1 &&
              isRightHpsId(mapSt.originSegmentId)) ||
              (!inSeptum(s.pos) &&
                s.pos.x < -0.1 &&
                isLeftHpsId(mapSt.originSegmentId)));
          if (!wrongChamberMyo) {
            addContrib(myoW, tmpContribDir, originHex);
            pathDrive = Math.max(pathDrive, myoW);
          }
        }
      } else if (chamberOk && depolMute > 0.04 && s.tissue === "atrial") {
        // AFib: skip pathway atrial LAT — pink PV wave is the field driver
        // AVRT: mute sinus / Bachmann atrial LAT; Kent fronts drive partial atrium
        const muteAtrialLat =
          (isAfib && fromMyoFocus) ||
          (isAvrt && (s.nearestId === "sa" || s.nearestId === "internodal"));
        if (
          !muteAtrialLat &&
          atrialSourceMayDriveSample(s.pos, s.tissue, s.nearestId, accessoryLive, avNodeLive)
        ) {
          const env = activationWavefront(delayedAge, 0.048);
          if (env > 0.015 && (groupOk || frontIntensity > 0.05)) {
            if (mapSt && mapSt.depolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.depolDir);
            else {
              tmpContribDir.copy(s.dir);
              if (lmLive?.reverse) tmpContribDir.negate();
            }
            projectOntoShellTangent(tmpContribDir, s.pos);
            if (!(accessoryLive && nearKentAvCross(s.pos, s.nearestId))) {
              clampDirToAvPlane(s.pos, tmpContribDir, true);
            }
            addContrib(env * 0.95 * frontMass(s.nearestId) * depolMute, tmpContribDir, s.nearestColor);
            pathDrive = Math.max(pathDrive, env);
          }
        }
      }

      // 3) Refractory plateau — tissue is activated; hold a dim droplet remnant until recovery.
      // Without this the field snaps off after the crest instead of physiologic refractory.
      // Only engage once the traveling crest has passed (don't flatten the droplet).
      if (
        chamberOk &&
        inRefractory &&
        depolMute > 0.15 &&
        frontIntensity < 0.2 &&
        delayedAge > 0.06 &&
        (s.tissue === "ventricular" || s.tissue === "atrial")
      ) {
        const plateauFrac = Math.max(0, 1 - delayedAge / apdSpanLocal);
        const plateauW =
          (s.tissue === "ventricular" ? 0.22 : 0.14) * (0.45 + 0.55 * plateauFrac) * depolMute;
        if (mapSt.depolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.depolDir);
        else tmpContribDir.copy(s.dir);
        projectOntoShellTangent(tmpContribDir, s.pos);
        if (s.tissue === "ventricular") biasVentricularApexward(tmpContribDir, s.pos);
        projectOntoShellTangent(tmpContribDir, s.pos);
        if (tmpContribDir.lengthSq() > 1e-10) tmpContribDir.normalize();
        const plateauColor = chamberLockedFieldColor(
          s.pos,
          mapSt.originColor || s.nearestColor,
          mapSt.originSegmentId ?? s.nearestId,
          blockedChamber,
        );
        addContrib(plateauW, tmpContribDir, plateauColor);
        pathDrive = Math.max(pathDrive, plateauW);
      }

      // 4) Recovery wavefront — only after local depol; chamber-local activation order.
      if (chamberOk && localRepol > 0.02 && hasDepolarized && lat < 1e8) {
        if (s.tissue === "ventricular") {
          const base =
            mapSt.depolDir.lengthSq() > 1e-10
              ? mapSt.depolDir
              : mapSt.repolDir.lengthSq() > 1e-10
                ? mapSt.repolDir
                : s.dir;
          fillChamberLocalRepolDir(
            tmpContribDir,
            base,
            s.dir,
            mapSt.originSegmentId ?? s.nearestId,
            s.pos,
          );
          if (tmpContribDir.lengthSq() < 1e-10) transmuralRepolDir(s.pos, tmpContribDir);
        } else {
          if (mapSt.repolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.repolDir);
          else if (mapSt.depolDir.lengthSq() > 1e-10) tmpContribDir.copy(mapSt.depolDir);
          else tmpContribDir.copy(s.dir);
          projectOntoShellTangent(tmpContribDir, s.pos);
          if (tmpContribDir.lengthSq() > 1e-10) tmpContribDir.normalize();
        }
        addContrib(localRepol * (s.tissue === "ventricular" ? 1.15 : 0.85), tmpContribDir, FIELD_REPOL_GREY);
        pathDrive = Math.max(pathDrive, localRepol);
      }

      // 5) Ectopy / pace / pre-excitation — same rippling shell from the focus
      const allowFocusField =
        chamberOk &&
        fromMyoFocus &&
        !!focusDir &&
        !(localRepol > 0.35 && s.tissue === "ventricular");
      if (allowFocusField && focusDir) {
        const ageForEnv = fromMyoFocus ? focusLocalAge : depolAge;
        const kentFocus = focusColor === 0xc070ff || focusColor === 0xa060e8;
        const env = activationWavefront(
          ageForEnv,
          isAfib && focusTissue === "atrial" ? 0.05 : kentFocus ? 0.07 : 0.058,
        );
        const fw =
          Math.max(env, engagedTract && !isAvrt ? 0.12 * activationWavefront(ageForEnv, 0.1) : 0) *
          (shellReached || (isAfib && focusTissue === "atrial") ? 1 : 0) *
          depolMute;
        if (fw > 0.015) {
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
            addContrib(
              fw * (isAfib && focusTissue === "atrial" ? 1.35 : kentFocus ? 1.4 : 1.2),
              focusDir,
              col,
            );
          }
          pvcDrive = fw;
        }
      }
      if (
        chamberOk &&
        engagedTract &&
        !inRefractory &&
        localRepol < 0.35 &&
        !(isAfib && focusTissue === "atrial") &&
        !isAvrt
      ) {
        // Late Purkinje engage after PVC — use tract tangent (traveling), not radial
        tmpContribDir.copy(s.dir);
        addContrib(0.28 * depolMute, tmpContribDir, focusColor ?? s.nearestColor);
        pvcDrive = Math.max(pvcDrive, 0.28 * depolMute);
      }

      // Ectopy: mute remapped pathway ahead of the shell
      if (anyEctopyWave && !shellReached && !fromMyoFocus && localRepol < 0.2) {
        const atrialWave = hasActiveAtrialFocus;
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
        !inHisCorridor &&
        !hisWaveLocal;
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
      // Only mute the razor-thin free-wall band glued to the fibrous plane
      // (sideways ring). Basal ventricular field below that stays live.
      const basalRingBlocked =
        s.tissue === "ventricular" &&
        !inSeptum(s.pos) &&
        s.pos.y > AV_JUNCTION.planeY - 0.07 &&
        !inHisCorridor &&
        !hisWaveLocal;
      if (junctionBlocked || atrialLeakBlocked || basalRingBlocked) {
        tmpFieldAcc.set(0, 0, 0);
        totalW = 0;
        bestW = 0;
      }

      // Ventricular shell grid: pull the local resultant toward the smoothed LAT
      // wavefront so each point shows one organized force (conduction → refractory),
      // not a pile of conflicting arrow directions.
      if (
        s.tissue === "ventricular" &&
        mapSt.lat < 1e8 &&
        mapSt.depolDir.lengthSq() > 1e-10 &&
        localRepol < 0.22 &&
        totalW > 1e-4 &&
        !isVf &&
        !hisWaveLocal &&
        !junctionBlocked &&
        !basalRingBlocked
      ) {
        const mag = tmpFieldAcc.length();
        tmpPathDir.copy(mapSt.depolDir);
        projectOntoShellTangent(tmpPathDir, s.pos);
        if (mag > 1e-6) {
          tmpFieldAcc
            .normalize()
            .lerp(tmpPathDir, 0.65)
            .normalize()
            .multiplyScalar(mag);
        } else {
          tmpFieldAcc.copy(tmpPathDir).multiplyScalar(totalW * 0.55);
        }
      }

      // Resultant magnitude at this sample (physiologic local field strength)
      let targetMag = 0;
      if (chamberOk && !junctionBlocked && !atrialLeakBlocked && !basalRingBlocked && totalW > 1e-4) {
        const vecMag = tmpFieldAcc.length();
        targetMag = Math.min(1.4, vecMag * 0.75 + totalW * 0.28);
      }
      // Refractory floor: once activated, keep a dim hold through APD even if wakes die
      if (
        chamberOk &&
        !junctionBlocked &&
        !atrialLeakBlocked &&
        !basalRingBlocked &&
        inRefractory &&
        targetMag < 0.14
      ) {
        const plateauFrac = Math.max(0, 1 - delayedAge / apdSpanLocal);
        targetMag = Math.max(
          targetMag,
          (s.tissue === "ventricular" ? 0.14 : 0.09) * (0.5 + 0.5 * plateauFrac),
        );
      }

      // Hard causal gate: broad myocardial wakes must not leave a ventricular
      // arrow visible before local activation. A live conduction front is the
      // exception: its tightly bounded wake is the wave emitted by the moving ball.
      // The normal 20 ms post-depolarization lag remains for the myocardial shell.
      const liveConductionWave = frontIntensity > 0.02;
      const waitingForVentricularArrival =
        s.tissue === "ventricular" &&
        lat < 1e8 &&
        delayedAge < 0 &&
        !liveConductionWave;
      if (waitingForVentricularArrival) {
        targetMag = 0;
        s.glow = 0;
      }

      // Smooth toward target: crest rises fast; plateau holds; recovery/trail fades gently
      const pastRecovered =
        lat < 1e8 && t > recovery + 0.12 && localRepol < 0.04 && targetMag < 0.03;
      if (targetMag > s.glow) {
        s.glow += (targetMag - s.glow) * (liveConductionWave ? 0.88 : 0.5);
      }
      else if (inRefractory) s.glow += (targetMag - s.glow) * 0.2;
      else s.glow += (targetMag - s.glow) * (pastRecovered ? 0.2 : 0.16);
      if (pastRecovered) s.glow *= 0.96;
      if (!chamberOk || junctionBlocked || atrialLeakBlocked || basalRingBlocked) s.glow *= isReentry ? 0.9 : 0.88;
      if (s.glow < 0.0035) s.glow = 0;

      // Soft handoff weight — only when this sample has local PVC drive (not global)
      const blendTarget =
        pathDrive + pvcDrive < 1e-4
          ? s.pvcBlend * 0.92
          : pvcDrive / (pathDrive + pvcDrive + 1e-6);
      s.pvcBlend = s.pvcBlend * 0.88 + blendTarget * 0.12;
      if (!chamberOk) s.pvcBlend *= 0.94;
      // AVRT / paced: never PVC-orange blend (paced uses lead color via focus contrib)
      if (isAvrt || isPaced) s.pvcBlend = 0;

      const intensity = s.glow;
      const show = intensity > 0.028;

      let dir = tmpPathDir;
      if (tmpFieldAcc.lengthSq() > 1e-8) {
        dir.copy(tmpFieldAcc).normalize();
      } else if (localRepol > 0.08 && s.tissue === "ventricular") {
        fillChamberLocalRepolDir(
          dir,
          mapSt.depolDir.lengthSq() > 1e-10 ? mapSt.depolDir : mapSt.repolDir,
          s.dir,
          mapSt.originSegmentId ?? s.nearestId,
          s.pos,
        );
      } else if (mapSt && mapSt.lat < 1e8 && mapSt.depolDir.lengthSq() > 1e-10) {
        dir.copy(mapSt.depolDir);
      } else {
        dir.copy(s.dir);
      }
      if (dir.lengthSq() > 1e-10) {
        if (hisWaveLocal && liveHisFront) {
          setHisPropagationDir(dir, s.pos, liveHisFront.pos);
        } else if (isVf && s.tissue === "ventricular") {
          const rate = opts.finding === "vfFine" ? 23 : 11;
          const phase =
            t * Math.PI * 2 * rate +
            s.pos.x * 8.7 +
            s.pos.y * 6.1 +
            s.pos.z * 10.3;
          tmpOutward.set(
            Math.sin(phase * 1.13),
            Math.cos(phase * 0.83 + s.pos.z * 4),
            Math.sin(phase * 1.47 + s.pos.x * 5),
          );
          projectOntoShellTangent(tmpOutward, s.pos);
          if (tmpOutward.lengthSq() > 1e-10) {
            tmpOutward.normalize();
            dir.lerp(tmpOutward, opts.finding === "vfFine" ? 0.9 : 0.68).normalize();
          }
        } else if (s.tissue === "ventricular") {
          projectOntoShellTangent(dir, s.pos);
          if (localRepol < 0.12) biasVentricularApexward(dir, s.pos);
          projectOntoShellTangent(dir, s.pos);
        }
        // Free-wall ventricle: keep LAT trajectory; clip length at the fibrous plane
        // instead of flattening the direction "down"/parallel to the plane.
        const freeWallVent =
          s.tissue === "ventricular" && !inSeptum(s.pos) && s.pos.y < AV_JUNCTION.planeY - 0.005;
        if (!freeWallVent) {
          clampDirToAvPlane(s.pos, dir, !allowAvCross);
        }
        // Hold the activation direction through the plateau. Arrows only reorient when
        // a strong new wavefront arrives or true recovery begins — not from weak LAT noise.
        const align = s.dirSmooth.lengthSq() > 1e-8 ? s.dirSmooth.dot(dir) : 1;
        const strongNew =
          bestW > 0.2 ||
          frontIntensity > 0.16 ||
          localRepol > 0.14 ||
          (fromMyoFocus && pvcDrive > 0.16) ||
          // On the myocardial activation front itself
          (delayedAge >= -0.04 && delayedAge < 0.08 && targetMag > 0.12);
        const inPlateau =
          inRefractory &&
          s.glow > 0.04 &&
          localRepol < 0.08 &&
          targetMag < 0.2;
        let lerpT: number;
        if (isVf) {
          lerpT = opts.finding === "vfFine" ? 0.82 : 0.5;
        } else if (inPlateau && !strongNew) {
          // Refractory: hold the activation direction — don't wander
          dir.copy(s.dirSmooth);
          lerpT = 0.04;
        } else if (align < -0.3 && !strongNew && s.glow > 0.1) {
          // Large opposing flip without a dominant new source — reject
          dir.copy(s.dirSmooth);
          lerpT = 0.05;
        } else {
          lerpT = show ? (strongNew ? 0.32 : 0.12) : 0.05;
        }
        if (hisWaveLocal) lerpT = 0.9;
        s.dirSmooth.lerp(dir, lerpT);
        if (s.dirSmooth.lengthSq() > 1e-8) s.dirSmooth.normalize();
        dir = s.dirSmooth;
        // Same free-wall exception as above — length clip handles the plane.
        if (!allowAvCross && !freeWallVent) clampDirToAvPlane(s.pos, dir, true);
      }

      const kentPurple = SEGMENT_FIELD_COLOR.accessory ?? 0xc070ff;
      // Purple wherever Kent dominates locally along the groove / tube
      const kentDrivingLocal =
        isAvrt &&
        ((bestW > 0.015 && isKentFieldColor(bestColor)) ||
          (accessoryLive &&
            nearKentAvCross(s.pos, s.nearestId) &&
            isKentFieldColor(bestColor) &&
            bestW > 0.01) ||
          (fromMyoFocus &&
            focusColor != null &&
            isKentFieldColor(focusColor) &&
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
          localRepol > 0.12 && !isAfib && bestColor === FIELD_REPOL_GREY
            ? FIELD_REPOL_GREY
            : localRepol > bestW * 0.85 && localRepol > 0.1 && !isAfib
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
        if (s.tissue === "ventricular" && pathColor !== FIELD_REPOL_GREY && localRepol < 0.12) {
          pathColor = chamberLockedFieldColor(
            s.pos,
            pathColor,
            mapSt.originSegmentId ?? s.nearestId,
            blockedChamber,
          );
        }
        const ectopyHex =
          focusColor && !isKentFieldColor(focusColor)
            ? focusColor
            : isEctopyFieldColor(bestColor) && !isKentFieldColor(bestColor)
              ? bestColor
              : 0xff8844;
        const blend = localRepol > 0.2 ? 0 : Math.min(1, Math.max(0, s.pvcBlend));
        const targetCol = tmpWaveColor.setHex(pathColor).lerp(tmpEctopyColor.setHex(ectopyHex), blend);
        s.colorSmooth.lerp(targetCol, liveConductionWave ? 0.82 : show ? 0.22 : 0.08);
        displayColor = s.colorSmooth.getHex();
      }

      if (fieldGroup.visible) {
        if (!show) {
          s.arrow.visible = false;
        } else {
          const arrowIntensity = intensity;
          let len = (0.041 + 0.105 * arrowIntensity);
          len = clipLenAtAvPlane(s.pos, dir, len);
          s.arrow.visible = true;
          s.arrow.position.copy(s.pos);
          s.arrow.setDirection(dir);
          s.arrow.setLength(len, len * 0.32, len * 0.2);
          s.arrow.setColor(displayColor);
          const lm = s.arrow.line.material;
          const cm = s.arrow.cone.material;
          const op =
            localRepol > 0.1 && displayColor === FIELD_REPOL_GREY
              ? 0.14 + 0.5 * arrowIntensity
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

      meanArrow.visible = !isVf;
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
        !isVf &&
        !(isAfib && (opts.mark === "TP" || opts.mark === "P")) &&
        Math.max(0, 0.03 + 0.22 * Math.min(1, s)) > 0.04;
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
