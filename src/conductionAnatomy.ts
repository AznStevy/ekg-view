import * as THREE from "three";
import type { SegmentId } from "./findings";
import {
  branchesForFinding,
  refractoryGlow,
  type PathwayProbePoint,
} from "./pathwayTiming";

export type SegmentMeta = {
  id: SegmentId;
  label: string;
  color: string;
  defaultOn: boolean;
};

export const SEGMENT_META: SegmentMeta[] = [
  { id: "sa", label: "SA node", color: "#f0c040", defaultOn: true },
  { id: "internodal", label: "Internodal tracts", color: "#e8a838", defaultOn: true },
  { id: "flutter", label: "Flutter circuit (CTI)", color: "#8a9aa8", defaultOn: false },
  { id: "av", label: "AV node", color: "#ff7a4a", defaultOn: true },
  { id: "avnrtSlow", label: "AVN slow pathway", color: "#9aa4ae", defaultOn: false },
  { id: "avnrtFast", label: "AVN fast pathway", color: "#b0b8c0", defaultOn: false },
  { id: "his", label: "Bundle of His", color: "#ff5e6c", defaultOn: true },
  { id: "rbb", label: "Right bundle", color: "#5ec8ff", defaultOn: true },
  { id: "lbb", label: "Left bundle", color: "#6ae0a8", defaultOn: true },
  { id: "lbba", label: "Left anterior fascicle", color: "#4ec890", defaultOn: true },
  { id: "lbbp", label: "Left posterior fascicle", color: "#3ab078", defaultOn: true },
  { id: "purkinjeR", label: "Purkinje (RV)", color: "#7ad4ff", defaultOn: true },
  { id: "purkinjeL", label: "Purkinje (LV)", color: "#88f0c0", defaultOn: true },
  { id: "accessory", label: "Kent (left)", color: "#c070ff", defaultOn: false },
  { id: "accessoryR", label: "Kent (right)", color: "#a060e8", defaultOn: false },
  { id: "myocardiumA", label: "Atrial myocardium", color: "#d08090", defaultOn: false },
  { id: "myocardiumV", label: "Ventricular myocardium", color: "#c06070", defaultOn: false },
];

const SEGMENT_COLORS: Record<SegmentId, number> = {
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

type PathSpec = {
  id: SegmentId;
  name: string;
  detail: string;
  points: [number, number, number][];
  radiusStart: number;
  radiusEnd: number;
  tubularSegments?: number;
  /** Radius mix along the path. Default smoothstep; smootherstep = gentler shoulders. */
  taperEase?: "smoothstep" | "smootherstep";
};

type GuideTubeSpec = {
  kind?: "tube";
  name: string;
  detail: string;
  points: [number, number, number][];
  radius?: number;
  tubularSegments?: number;
};

/** Orifice / junction as a grey ring (vena cava, CS ostium). */
type GuideRingSpec = {
  kind: "ring";
  name: string;
  detail: string;
  center: [number, number, number];
  /** Axis of the vessel / orifice (out of the RA). */
  normal: [number, number, number];
  radius: number;
  tubeRadius?: number;
};

/** Septal landmark as a grey oval outline (fossa ovalis). */
type GuideOvalSpec = {
  kind: "oval";
  name: string;
  detail: string;
  center: [number, number, number];
  /** Plane normal (≈ toward LA / left). */
  normal: [number, number, number];
  /** Preferred major-axis direction (projected onto the plane). */
  majorHint: [number, number, number];
  major: number;
  minor: number;
  tubeRadius?: number;
};

type GuideSpec = GuideTubeSpec | GuideRingSpec | GuideOvalSpec;

/**
 * RA anatomic guide anchors (patient frame: +X left, +Y superior, +Z anterior).
 * Placed relative to SA / CTI / CS used by the conduction paths.
 */
/** Orifice center; SA sits on the lateral rim along the sulcus. */
const SVC_RA_CENTER: [number, number, number] = [-0.47, 0.64, 0.17];
/** Inferior RA orifice; lateral CTI starts just superior-lateral to this ring. */
const IVC_RA_CENTER: [number, number, number] = [-0.4, -0.18, 0.1];
const CS_OST_CENTER: [number, number, number] = [-0.06, -0.01, -0.16];
/** Mid interatrial septum, between AV (Koch) and superior septal flutter limb. */
const FOSSA_CENTER: [number, number, number] = [0.01, 0.26, -0.14];

/** Thin grey anatomic landmarks (context only — not impulse pathways).
 *  AV valve rings lie in a shared plane ≈ perpendicular to the long axis (−Y),
 *  so they stay “en face” relative to the heart after anatomic orientation.
 *  Vena-cava junctions are orifice rings; Eustachian is a ridge; fossa is a septal oval.
 */
const ANATOMY_GUIDES: GuideSpec[] = [
  {
    name: "Tricuspid annulus",
    detail: "RA–RV junction · flutter circuit boundary · more apical than mitral",
    radius: 0.007,
    tubularSegments: 72,
    // Ellipse in AV plane (normal ≈ apex); right-sided, slightly anterior
    points: [
      [0.136, 0.02, 0.082],
      [0.079, 0.03, 0.195],
      [-0.042, 0.033, 0.265],
      [-0.195, 0.027, 0.276],
      [-0.339, 0.013, 0.223],
      [-0.434, -0.004, 0.121],
      [-0.456, -0.02, -0.002],
      [-0.399, -0.03, -0.115],
      [-0.278, -0.033, -0.185],
      [-0.125, -0.027, -0.196],
      [0.019, -0.013, -0.143],
      [0.114, 0.004, -0.041],
      [0.136, 0.02, 0.082],
    ],
  },
  {
    kind: "ring",
    name: "IVC–RA junction",
    detail: "Inferior vena cava orifice · inferior RA · CTI lateral border",
    center: IVC_RA_CENTER,
    // Vessel axis inferior, slightly right / anterior toward free wall
    normal: [-0.12, -1, 0.08],
    radius: 0.11,
    tubeRadius: 0.007,
  },
  {
    kind: "ring",
    name: "Coronary sinus ostium",
    detail: "Posteroseptal RA · near triangle of Koch",
    center: CS_OST_CENTER,
    // CS enters from left/posterior
    normal: [0.55, -0.15, -0.82],
    radius: 0.045,
    tubeRadius: 0.006,
  },
  {
    // Posterior CTI border: medial/posterior IVC rim → CS ostium
    name: "Eustachian ridge",
    detail: "IVC to CS · forms CTI posterior border",
    radius: 0.0055,
    tubularSegments: 48,
    points: [
      [-0.32, -0.16, -0.01],
      [-0.24, -0.1, -0.06],
      [-0.15, -0.05, -0.11],
      [-0.09, -0.02, -0.14],
      CS_OST_CENTER,
    ],
  },
  {
    kind: "oval",
    name: "Fossa ovalis (septum)",
    detail: "Interatrial septum · mid RA oval depression",
    center: FOSSA_CENTER,
    normal: [1, 0.04, 0.18],
    majorHint: [0.05, 1, -0.1],
    major: 0.13,
    minor: 0.085,
    tubeRadius: 0.005,
  },
  {
    kind: "ring",
    name: "SVC–RA junction",
    detail: "Superior vena cava orifice · SA node on lateral rim",
    center: SVC_RA_CENTER,
    // Vessel axis superior; SA sits on the lateral (right / −X) rim
    normal: [0.08, 1, -0.12],
    radius: 0.115,
    tubeRadius: 0.007,
  },
  {
    name: "Mitral annulus (guide)",
    detail: "LA–LV junction · slightly more basal/posterior than tricuspid",
    radius: 0.006,
    tubularSegments: 64,
    // Same AV plane as TA; left-sided, slightly basal (+Y) and posterior (−Z)
    points: [
      [0.598, 0.096, 0.004],
      [0.554, 0.105, 0.1],
      [0.452, 0.108, 0.163],
      [0.32, 0.103, 0.178],
      [0.194, 0.092, 0.139],
      [0.106, 0.078, 0.058],
      [0.082, 0.064, -0.044],
      [0.126, 0.055, -0.14],
      [0.228, 0.052, -0.203],
      [0.36, 0.057, -0.218],
      [0.486, 0.068, -0.179],
      [0.574, 0.082, -0.098],
      [0.598, 0.096, 0.004],
    ],
  },
];

function createGuideMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x7a8a96,
    roughness: 0.55,
    metalness: 0.05,
    emissive: 0x3a4550,
    emissiveIntensity: 0.08,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
}

function tagAnatomyGuide(mesh: THREE.Mesh, name: string, detail: string): THREE.Mesh {
  mesh.name = name;
  mesh.userData.segmentName = name;
  mesh.userData.segmentDetail = detail;
  mesh.userData.segmentId = "guide";
  mesh.userData.isConduction = false;
  mesh.userData.isAnatomyGuide = true;
  mesh.userData.baseEmissive = 0.08;
  return mesh;
}

function createGuideTube(spec: GuideTubeSpec): THREE.Mesh {
  const curve = makeCurve(spec.points);
  const r = spec.radius ?? 0.007;
  const geo = createTaperedTubeGeometry(
    curve,
    spec.tubularSegments ?? 40,
    r,
    r * 0.85,
    6,
  );
  return tagAnatomyGuide(new THREE.Mesh(geo, createGuideMaterial()), spec.name, spec.detail);
}

function createGuideRing(spec: GuideRingSpec): THREE.Mesh {
  const tubeR = spec.tubeRadius ?? 0.007;
  const geo = new THREE.TorusGeometry(spec.radius, tubeR, 8, 48);
  const mesh = new THREE.Mesh(geo, createGuideMaterial());
  mesh.position.set(...spec.center);
  const n = new THREE.Vector3(...spec.normal).normalize();
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  return tagAnatomyGuide(mesh, spec.name, spec.detail);
}

function createGuideOval(spec: GuideOvalSpec): THREE.Mesh {
  const n = vecUnit(spec.normal);
  let majorDir = vecAdd(spec.majorHint, n, -vecDot(spec.majorHint, n));
  if (vecLen(majorDir) < 0.12) {
    const ref: [number, number, number] = Math.abs(n[1]) < 0.85 ? [0, 1, 0] : [0, 0, 1];
    majorDir = vecCross(n, ref);
  }
  majorDir = vecUnit(majorDir);
  const minorDir = vecUnit(vecCross(n, majorDir));
  const steps = 40;
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    pts.push([
      spec.center[0] + spec.major * c * majorDir[0] + spec.minor * s * minorDir[0],
      spec.center[1] + spec.major * c * majorDir[1] + spec.minor * s * minorDir[1],
      spec.center[2] + spec.major * c * majorDir[2] + spec.minor * s * minorDir[2],
    ]);
  }
  const curve = new THREE.CatmullRomCurve3(
    pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    true,
    "centripetal",
    0.5,
  );
  const tubeR = spec.tubeRadius ?? 0.005;
  // Closed TubeGeometry so the oval reads as one continuous rim (no seam gap).
  const geo = new THREE.TubeGeometry(curve, 64, tubeR, 6, true);
  return tagAnatomyGuide(new THREE.Mesh(geo, createGuideMaterial()), spec.name, spec.detail);
}

function createGuideMesh(spec: GuideSpec): THREE.Mesh {
  if (spec.kind === "ring") return createGuideRing(spec);
  if (spec.kind === "oval") return createGuideOval(spec);
  return createGuideTube(spec);
}

/**
 * Patient frame: +X left, +Y superior, +Z anterior.
 *
 * Layout inside a ~unit heart sphere (apex left-inferior-anterior):
 * - SA node: SVC–RA junction (right, superior, along sulcus terminalis)
 * - AV node: triangle of Koch (inferior RA septum, near CS)
 * - His: central fibrous body → crest of muscular IV septum
 * - RBB: right septal surface → moderator band → anterior papillary
 * - LBB: left septal cascade → anterior / posterior fascicles
 * - Purkinje: endocardial arborization of both ventricles
 */
const SA: [number, number, number] = [-0.52, 0.58, 0.22];
const AV: [number, number, number] = [0.0, 0.02, -0.12];
/** Compact AV node radius; dual pathways wrap a larger translucent halo in AVNRT. */
const AV_R = 0.048;
const AV_HALO_R = AV_R * 1.55;
/** AVNRT loop radius — sits on the translucent halo surface. */
const AVN_LOOP_R = AV_HALO_R * 1.02;
const HIS_BRANCH: [number, number, number] = [0.05, -0.28, -0.04];
const LBB_ORIGIN: [number, number, number] = [0.14, -0.34, 0.0];
/** Fascicle tips — Purkinje arborizations must start here so tubes visibly join.
 *  Kept inside FIELD_ELLIPSOID with margin for tube radius / Catmull-Rom overshoot. */
const LAF_TIP: [number, number, number] = [0.5, -0.82, 0.24];
const LPF_TIP: [number, number, number] = [0.28, -1.08, 0.0];
const SEPTAL_TIP: [number, number, number] = [0.12, -1.02, -0.02];
/** Distal tip of LV anterolateral Purkinje · base (left Kent ventricular insertion). */
const PURK_L_ANT_BASE_TIP: [number, number, number] = [0.52, -0.34, 0.1];
/** Distal tip of RV free-wall Purkinje · superior (right Kent ventricular insertion). */
const PURK_R_FW_SUP_TIP: [number, number, number] = [-0.58, -0.28, 0.18];
const RBB_MID: [number, number, number] = [-0.08, -0.55, 0.18];
const RBB_APEX: [number, number, number] = [-0.18, -0.95, 0.32];
const MOD_BAND_END: [number, number, number] = [-0.48, -0.62, 0.48];

/** Left-lateral Kent · atrial insert outside mitral ring; LV end = anterolateral Purkinje · base tip. */
const ACC_L_LA: [number, number, number] = [0.64, 0.16, 0.06];
const ACC_L_EPIC: [number, number, number] = [0.72, 0.06, 0.1];
/** Right-lateral Kent · atrial insert outside tricuspid ring; RV end = free-wall superior tip. */
const ACC_R_LA: [number, number, number] = [-0.55, 0.08, 0.22];
const ACC_R_EPIC: [number, number, number] = [-0.68, 0.0, 0.32];

/** CTI flutter ring landmarks (RA around tricuspid annulus) */
const CTI_LAT: [number, number, number] = [-0.48, -0.02, 0.18];
const CTI_MED: [number, number, number] = [-0.06, 0.0, -0.14];
const SEPT_SUP: [number, number, number] = [0.06, 0.42, -0.16];
const ROOF_LAT: [number, number, number] = [-0.42, 0.62, 0.2];

/** Must stay in sync with applyAnatomicOrientation when pose changes. */
const ANATOMIC_EULER_DEG = { z: 22, x: -38, y: 8 } as const;

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

/** Inverse of Three.js ZYX euler (Rz·Ry·Rx) — map world → heart-local. */
function worldToLocalAnatomic(v: [number, number, number]): [number, number, number] {
  const z = degToRad(-ANATOMIC_EULER_DEG.z);
  const y = degToRad(-ANATOMIC_EULER_DEG.y);
  const x = degToRad(-ANATOMIC_EULER_DEG.x);
  const cz = Math.cos(z);
  const sz = Math.sin(z);
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cx = Math.cos(x);
  const sx = Math.sin(x);
  let x1 = v[0] * cz - v[1] * sz;
  let y1 = v[0] * sz + v[1] * cz;
  let z1 = v[2];
  const x2 = x1 * cy + z1 * sy;
  const y2 = y1;
  const z2 = -x1 * sy + z1 * cy;
  return [x2, y2 * cx - z2 * sx, y2 * sx + z2 * cx];
}

function vecSub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vecAdd(a: [number, number, number], b: [number, number, number], s = 1): [number, number, number] {
  return [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
}

function vecDot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vecLen(v: [number, number, number]): number {
  return Math.hypot(v[0], v[1], v[2]) || 1;
}

function vecUnit(v: [number, number, number]): [number, number, number] {
  const m = vecLen(v);
  return [v[0] / m, v[1] / m, v[2] / m];
}

function vecCross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Straight AV → bifurcation axis (His must stay collinear — no off-axis control points). */
const HIS_DIR = vecUnit(vecSub(HIS_BRANCH, AV));
/** Loop / penetrating-His junction on the AV halo, on the His axis. */
const HIS_PEN: [number, number, number] = vecAdd(AV, HIS_DIR, AVN_LOOP_R);

/**
 * Dual-pathway loop on the AV halo. Diameter is fixed on the His axis (HIS_PEN unchanged);
 * the wrap direction is tipped partly toward the AP camera so the ring faces the user a bit more.
 */
function avnrtLimbPoints(side: number, steps: number): [number, number, number][] {
  const C: [number, number, number] = [AV[0], AV[1], AV[2]];
  const R = AVN_LOOP_R;
  const U = HIS_DIR;

  // Edge-on / His-plane wrap (previous look)
  let ref: [number, number, number] = [0, 0, 1];
  if (Math.abs(vecDot(U, ref)) > 0.85) ref = [1, 0, 0];
  const NEdge = vecUnit(vecCross(U, ref));
  const VEdge = vecUnit(vecCross(NEdge, U));

  // Most face-on plane that still contains His (normal = camera ⊥ His)
  const cam = vecUnit(worldToLocalAnatomic([0, 0, 1]));
  let NFace = vecAdd(cam, U, -vecDot(cam, U));
  if (vecLen(NFace) < 0.15) NFace = NEdge;
  else NFace = vecUnit(NFace);
  const VFace = vecUnit(vecCross(NFace, U));

  // Blend toward the user without leaving the His diameter / halo
  const faceBlend = 0.42;
  const VMixed: [number, number, number] = [
    VEdge[0] + (VFace[0] - VEdge[0]) * faceBlend,
    VEdge[1] + (VFace[1] - VEdge[1]) * faceBlend,
    VEdge[2] + (VFace[2] - VEdge[2]) * faceBlend,
  ];
  const V = vecUnit(vecAdd(VMixed, U, -vecDot(VMixed, U)));

  const pts: [number, number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = Math.PI + (i / steps) * Math.PI; // atrial (π) → His (2π)
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    pts.push([
      C[0] + R * (cos * U[0] + side * sin * V[0]),
      C[1] + R * (cos * U[1] + side * sin * V[1]),
      C[2] + R * (cos * U[2] + side * sin * V[2]),
    ]);
  }
  pts[0] = vecAdd(C, U, -R);
  pts[pts.length - 1] = [HIS_PEN[0], HIS_PEN[1], HIS_PEN[2]];
  return pts;
}

const AVNRT_SLOW_POINTS = avnrtLimbPoints(-1, 18);
const AVNRT_FAST_POINTS = avnrtLimbPoints(1, 18);

const PATHS: PathSpec[] = [
  // —— Internodal / atrial ——
  {
    id: "internodal",
    name: "Anterior internodal tract",
    detail: "SA → anterior RA → septum → AV",
    radiusStart: 0.028,
    radiusEnd: 0.016,
    tubularSegments: 56,
    points: [
      SA,
      [-0.38, 0.52, 0.32],
      [-0.18, 0.42, 0.22],
      [-0.02, 0.28, 0.05],
      [0.02, 0.14, -0.06],
      AV,
    ],
  },
  {
    id: "internodal",
    name: "Bachmann bundle",
    detail: "Interatrial conduction · superior LA",
    radiusStart: 0.03,
    radiusEnd: 0.014,
    tubularSegments: 64,
    taperEase: "smootherstep",
    points: [
      SA,
      [-0.28, 0.68, 0.08],
      [-0.05, 0.74, -0.05],
      [0.22, 0.7, -0.15],
      [0.45, 0.58, -0.22],
      [0.55, 0.42, -0.18],
    ],
  },
  {
    id: "internodal",
    name: "Middle internodal tract",
    detail: "Wenckebach · through atrial septum",
    radiusStart: 0.022,
    radiusEnd: 0.014,
    points: [
      SA,
      [-0.3, 0.45, 0.05],
      [-0.12, 0.28, -0.08],
      AV,
    ],
  },
  {
    id: "internodal",
    name: "Posterior internodal (Thorel)",
    detail: "Crista terminalis → CS ostium → AV",
    radiusStart: 0.024,
    radiusEnd: 0.014,
    tubularSegments: 56,
    points: [
      SA,
      [-0.58, 0.4, 0.18],
      [-0.55, 0.22, 0.12],
      [-0.4, 0.1, -0.02],
      [-0.18, 0.04, -0.18],
      [-0.06, 0.02, -0.16],
      AV,
    ],
  },
  {
    id: "internodal",
    name: "SA node extension (sulcus)",
    detail: "Crescent along sulcus terminalis",
    radiusStart: 0.032,
    radiusEnd: 0.018,
    points: [
      [-0.48, 0.68, 0.18],
      SA,
      [-0.55, 0.48, 0.28],
      [-0.58, 0.35, 0.22],
    ],
  },

  // —— CTI-dependent flutter macro-reentry (CCW order: CTI → septum → roof → crista) ——
  {
    id: "flutter",
    name: "Cavotricuspid isthmus",
    detail: "IVC–tricuspid corridor · typical flutter slow zone",
    radiusStart: 0.008,
    radiusEnd: 0.007,
    tubularSegments: 40,
    points: [
      CTI_LAT,
      [-0.38, -0.04, 0.1],
      [-0.22, -0.02, -0.02],
      CTI_MED,
    ],
  },
  {
    id: "flutter",
    name: "Septal ascending limb",
    detail: "CS / Koch → superior RA septum",
    radiusStart: 0.008,
    radiusEnd: 0.007,
    tubularSegments: 48,
    points: [
      CTI_MED,
      [-0.02, 0.12, -0.14],
      [0.02, 0.28, -0.16],
      SEPT_SUP,
    ],
  },
  {
    id: "flutter",
    name: "RA roof",
    detail: "Superior RA · toward SVC / sulcus",
    radiusStart: 0.008,
    radiusEnd: 0.007,
    tubularSegments: 48,
    points: [
      SEPT_SUP,
      [-0.12, 0.55, -0.05],
      [-0.28, 0.62, 0.08],
      ROOF_LAT,
    ],
  },
  {
    id: "flutter",
    name: "Crista terminalis (descending)",
    detail: "Lateral RA · crista toward IVC / CTI",
    radiusStart: 0.008,
    radiusEnd: 0.007,
    tubularSegments: 56,
    points: [
      ROOF_LAT,
      [-0.52, 0.4, 0.24],
      [-0.55, 0.2, 0.22],
      [-0.52, 0.08, 0.2],
      CTI_LAT,
    ],
  },

  // —— Dual AV-nodal pathways · full reentrant loop on the AV halo ——
  // Slow (posteroinferior) + fast (anterosuperior) share atrial & His poles.
  {
    id: "avnrtSlow",
    name: "Slow pathway (AVN loop)",
    detail: "Posteroinferior half-loop · typical anterograde / atypical retrograde limb",
    radiusStart: 0.0075,
    radiusEnd: 0.0055,
    tubularSegments: 64,
    points: AVNRT_SLOW_POINTS,
  },
  {
    id: "avnrtFast",
    name: "Fast pathway (AVN loop)",
    detail: "Anterosuperior half-loop · typical retrograde / atypical anterograde limb",
    radiusStart: 0.007,
    radiusEnd: 0.0055,
    tubularSegments: 64,
    points: AVNRT_FAST_POINTS,
  },

  // —— His (collinear AV → HIS_PEN → HIS_BRANCH — no off-axis mids) ——
  {
    id: "his",
    name: "Penetrating His bundle",
    detail: "Compact AVN → halo exit · meets dual-pathway split",
    radiusStart: 0.028,
    radiusEnd: 0.032,
    tubularSegments: 24,
    points: [AV, HIS_PEN],
  },
  {
    id: "his",
    name: "Branching His bundle",
    detail: "From dual-pathway / penetrating junction → bifurcation",
    radiusStart: 0.032,
    radiusEnd: 0.028,
    tubularSegments: 32,
    points: [HIS_PEN, HIS_BRANCH],
  },

  // —— Right bundle ——
  // RV is patient's right (−X) and more anterior (+Z) than LV
  {
    id: "rbb",
    name: "Right bundle branch",
    detail: "Right septal subendocardium",
    radiusStart: 0.028,
    radiusEnd: 0.014,
    tubularSegments: 72,
    points: [
      HIS_BRANCH,
      [-0.05, -0.4, 0.08],
      RBB_MID,
      [-0.15, -0.72, 0.28],
      RBB_APEX,
    ],
  },
  {
    id: "rbb",
    name: "Moderator band",
    detail: "Septomarginal trabecula → ant. papillary",
    radiusStart: 0.018,
    radiusEnd: 0.012,
    tubularSegments: 40,
    points: [
      RBB_APEX,
      [-0.32, -0.88, 0.42],
      [-0.45, -0.75, 0.52],
      MOD_BAND_END,
    ],
  },

  // —— Left bundle / fascicles ——
  // LV is patient's left (+X). LAF = anterosuperior; LPF = posteroinferior; septal hugs septum.
  {
    id: "lbb",
    name: "Left bundle (cascade)",
    detail: "Left septal surface under aortic cusp",
    radiusStart: 0.028,
    radiusEnd: 0.028,
    points: [HIS_BRANCH, [0.1, -0.3, -0.02], LBB_ORIGIN],
  },
  {
    id: "lbba",
    name: "Left anterior fascicle",
    detail: "Thin · anterosuperior LV / AL papillary",
    radiusStart: 0.026,
    radiusEnd: 0.01,
    tubularSegments: 56,
    points: [
      LBB_ORIGIN,
      [0.22, -0.28, 0.16],
      [0.35, -0.32, 0.32],
      [0.45, -0.48, 0.38],
      [0.52, -0.65, 0.34],
      LAF_TIP,
    ],
  },
  {
    id: "lbbp",
    name: "Left posterior fascicle",
    detail: "Broad · inferior–posterior LV / PM papillary",
    radiusStart: 0.028,
    radiusEnd: 0.012,
    tubularSegments: 56,
    points: [
      LBB_ORIGIN,
      [0.18, -0.48, -0.14],
      [0.26, -0.68, -0.22],
      [0.32, -0.88, -0.16],
      [0.3, -1.0, -0.06],
      LPF_TIP,
    ],
  },
  {
    id: "lbb",
    name: "Left septal fascicle",
    detail: "Mid-septal fibers (variable) · stays on left septum",
    radiusStart: 0.022,
    radiusEnd: 0.008,
    tubularSegments: 40,
    points: [
      LBB_ORIGIN,
      [0.12, -0.48, 0.02],
      [0.1, -0.68, 0.04],
      [0.1, -0.88, 0.02],
      SEPTAL_TIP,
    ],
  },

  // —— RV Purkinje (stay right of septum: X ≲ 0, more anterior +Z) ——
  {
    id: "purkinjeR",
    name: "RV free wall Purkinje · superior",
    detail: "From anterior papillary region",
    radiusStart: 0.012,
    radiusEnd: 0.005,
    tubularSegments: 40,
    points: [
      MOD_BAND_END,
      [-0.58, -0.55, 0.45],
      [-0.65, -0.4, 0.32],
      PURK_R_FW_SUP_TIP,
    ],
  },
  {
    id: "purkinjeR",
    name: "RV free wall Purkinje · mid",
    detail: "Lateral RV endocardium",
    radiusStart: 0.011,
    radiusEnd: 0.004,
    points: [
      MOD_BAND_END,
      [-0.62, -0.72, 0.4],
      [-0.6, -0.92, 0.28],
      [-0.48, -1.05, 0.15],
    ],
  },
  {
    id: "purkinjeR",
    name: "RV free wall Purkinje · inferior",
    detail: "Inferior RV",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      RBB_APEX,
      [-0.35, -1.05, 0.28],
      [-0.42, -1.15, 0.15],
      [-0.38, -1.18, 0.02],
    ],
  },
  {
    id: "purkinjeR",
    name: "RV apical Purkinje",
    detail: "RV apex network",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      RBB_APEX,
      [-0.22, -1.12, 0.28],
      [-0.12, -1.2, 0.18],
      [-0.08, -1.18, 0.05],
    ],
  },
  {
    id: "purkinjeR",
    name: "RV septal Purkinje",
    detail: "Right septal arborization",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      RBB_MID,
      [-0.1, -0.68, 0.14],
      [-0.08, -0.88, 0.1],
      [-0.06, -1.05, 0.04],
    ],
  },

  // —— LV Purkinje · each branch starts at a fascicle tip; territories stay apart ——
  // Kept well inside FIELD_ELLIPSOID so tubes don't poke through the ovoid shell.
  // LAF territory: anterolateral free wall / base (high +X, +Z)
  {
    id: "purkinjeL",
    name: "LV anterolateral Purkinje",
    detail: "From LAF tip · lateral free wall",
    radiusStart: 0.012,
    radiusEnd: 0.004,
    tubularSegments: 40,
    points: [
      LAF_TIP,
      [0.56, -0.86, 0.16],
      [0.56, -0.9, 0.04],
      [0.5, -0.92, -0.04],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV anterolateral Purkinje · apex",
    detail: "From LAF tip · apical free wall",
    radiusStart: 0.011,
    radiusEnd: 0.004,
    points: [
      LAF_TIP,
      [0.48, -0.92, 0.14],
      [0.44, -1.0, 0.04],
      [0.42, -1.04, -0.04],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV anterolateral Purkinje · base",
    detail: "From LAF tip · toward LV base / LVOT",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      LAF_TIP,
      [0.58, -0.68, 0.28],
      [0.6, -0.5, 0.22],
      PURK_L_ANT_BASE_TIP,
    ],
  },
  // LPF territory: inferior–posterior (lower +X, −Z)
  {
    id: "purkinjeL",
    name: "LV inferior Purkinje",
    detail: "From LPF tip · inferior wall",
    radiusStart: 0.012,
    radiusEnd: 0.004,
    points: [
      LPF_TIP,
      [0.26, -1.1, -0.08],
      [0.22, -1.06, -0.2],
      [0.26, -0.96, -0.26],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV posterolateral Purkinje",
    detail: "From LPF tip · posterolateral free wall",
    radiusStart: 0.011,
    radiusEnd: 0.004,
    points: [
      LPF_TIP,
      [0.4, -1.05, -0.12],
      [0.5, -0.95, -0.22],
      [0.52, -0.82, -0.26],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV inferior Purkinje · basal",
    detail: "From LPF tip · toward posterior base",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      LPF_TIP,
      [0.34, -0.95, -0.14],
      [0.38, -0.78, -0.24],
      [0.36, -0.6, -0.22],
    ],
  },
  // Septal territory: hugs left septum (X ≈ 0.1–0.2)
  {
    id: "purkinjeL",
    name: "LV septal Purkinje · superior",
    detail: "From septal tip · mid-septum toward base",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      SEPTAL_TIP,
      [0.14, -0.88, 0.0],
      [0.15, -0.7, -0.02],
      [0.14, -0.48, -0.04],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV septal Purkinje · apex",
    detail: "From septal tip · apical septum",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      SEPTAL_TIP,
      [0.14, -1.08, -0.04],
      [0.16, -1.12, -0.06],
      [0.2, -1.1, -0.08],
    ],
  },

  // —— Accessory pathways (WPW / AVRT) · left & right Kent ——
  // Outside the AV valve orifices (epicardial groove), then to distal Purkinje tips
  // so ortho/anti circuits close through the Purkinje network.
  {
    id: "accessory",
    name: "Kent bundle (left lateral)",
    detail: "AVRT limb · AV ↔ LA ↔ epicardial groove ↔ LV anterolateral Purkinje · base tip",
    radiusStart: 0.015,
    radiusEnd: 0.004,
    tubularSegments: 96,
    points: [
      AV,
      [0.08, 0.12, -0.12],
      [0.2, 0.22, -0.16],
      [0.36, 0.26, -0.1],
      [0.5, 0.22, -0.02],
      ACC_L_LA,
      ACC_L_EPIC,
      [0.7, -0.02, 0.12],
      [0.66, -0.12, 0.16],
      [0.6, -0.22, 0.14],
      [0.56, -0.28, 0.12],
      PURK_L_ANT_BASE_TIP,
    ],
  },
  {
    id: "accessoryR",
    name: "Kent bundle (right lateral)",
    detail: "AVRT limb · AV ↔ RA ↔ epicardial groove ↔ RV free-wall Purkinje · superior tip",
    radiusStart: 0.015,
    radiusEnd: 0.004,
    tubularSegments: 96,
    points: [
      AV,
      [-0.08, 0.1, -0.06],
      [-0.22, 0.14, 0.06],
      [-0.38, 0.12, 0.14],
      ACC_R_LA,
      ACC_R_EPIC,
      [-0.7, -0.08, 0.34],
      [-0.68, -0.14, 0.3],
      [-0.64, -0.2, 0.24],
      [-0.6, -0.24, 0.2],
      PURK_R_FW_SUP_TIP,
    ],
  },
];

function makeCurve(points: [number, number, number][]): THREE.CatmullRomCurve3 {
  const vecs = points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  // Centripetal avoids the end-loop / overshoot common with "catmullrom" + tension,
  // which made distal vectors aim sideways or backward near fiber tips.
  return new THREE.CatmullRomCurve3(vecs, false, "centripetal", 0.5);
}

/**
 * Direction of travel along a curve toward a parametric terminus.
 * Prefer a finite look-ahead toward uEnd over getTangentAt(), which is unreliable
 * near endpoints (and after Catmull-Rom curls).
 */
function travelDirAt(
  curve: THREE.Curve<THREE.Vector3>,
  u: number,
  uEnd: number,
): THREE.Vector3 {
  const u0 = THREE.MathUtils.clamp(u, 0, 1);
  const end = THREE.MathUtils.clamp(uEnd, 0, 1);
  const toward = Math.sign(end - u0) || (end >= 0.5 ? 1 : -1);
  const span = 0.08;

  let from = u0;
  let to = THREE.MathUtils.clamp(u0 + toward * span, 0, 1);
  // Already at / past the tip: sample the last segment leading into the end
  if (Math.abs(to - from) < 1e-5) {
    to = end;
    from = THREE.MathUtils.clamp(end - toward * span, 0, 1);
  }

  const a = curve.getPointAt(from, new THREE.Vector3());
  const b = curve.getPointAt(to, new THREE.Vector3());
  const dir = b.sub(a);
  if (dir.lengthSq() > 1e-10) return dir.normalize();

  // Ultra-short leftover: chord from a bit before the tip into the tip
  const tip = curve.getPointAt(end, new THREE.Vector3());
  const prev = curve.getPointAt(
    THREE.MathUtils.clamp(end - toward * Math.max(span, 0.02), 0, 1),
    new THREE.Vector3(),
  );
  const fallback = tip.sub(prev);
  if (fallback.lengthSq() > 1e-10) return fallback.normalize();
  return new THREE.Vector3(0, toward > 0 ? -1 : 1, 0);
}

/** Tube with radius taper along the path (same approach as cath-view) */
function createTaperedTubeGeometry(
  curve: THREE.Curve<THREE.Vector3>,
  tubularSegments: number,
  radiusStart: number,
  radiusEnd: number,
  radialSegments: number,
  taperEase: "smoothstep" | "smootherstep" = "smoothstep",
): THREE.BufferGeometry {
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const normal = new THREE.Vector3();
  const vertex = new THREE.Vector3();

  for (let i = 0; i <= tubularSegments; i++) {
    const t = i / tubularSegments;
    const p = curve.getPointAt(t);
    const N = frames.normals[i]!;
    const B = frames.binormals[i]!;
    // smootherstep = C² ease — gentler shoulders so thick→thin doesn't kink
    const mix =
      taperEase === "smootherstep"
        ? t * t * t * (t * (t * 6 - 15) + 10)
        : t * t * (3 - 2 * t);
    const radius = THREE.MathUtils.lerp(radiusStart, radiusEnd, mix);

    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const angle = v * Math.PI * 2;
      const sin = Math.sin(angle);
      const cos = -Math.cos(angle);

      normal.x = cos * N.x + sin * B.x;
      normal.y = cos * N.y + sin * B.y;
      normal.z = cos * N.z + sin * B.z;
      normal.normalize();

      vertex.x = p.x + radius * normal.x;
      vertex.y = p.y + radius * normal.y;
      vertex.z = p.z + radius * normal.z;

      positions.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(t, v);
    }
  }

  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * (radialSegments + 1) + j;
      const b = (i + 1) * (radialSegments + 1) + j;
      const c = (i + 1) * (radialSegments + 1) + j + 1;
      const d = i * (radialSegments + 1) + j + 1;
      indices.push(a, b, d, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return geo;
}

function createPathMesh(spec: PathSpec): THREE.Mesh {
  const curve = makeCurve(spec.points);
  const geo = createTaperedTubeGeometry(
    curve,
    spec.tubularSegments ?? 48,
    spec.radiusStart,
    spec.radiusEnd,
    spec.id === "flutter" ? 6 : 10,
    spec.taperEase ?? "smoothstep",
  );
  const isFlutter = spec.id === "flutter";
  const isAccessory = spec.id === "accessory" || spec.id === "accessoryR";
  const isAvnrt = spec.id === "avnrtSlow" || spec.id === "avnrtFast";
  // Slow/fast limbs: grey inside the AV sphere; accessory stays vivid purple
  const color = isFlutter || isAvnrt ? 0x9aa4ae : SEGMENT_COLORS[spec.id];
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: isFlutter || isAvnrt ? 0.55 : 0.35,
    metalness: isFlutter || isAvnrt ? 0.05 : 0.08,
    emissive: isFlutter || isAvnrt ? 0x3a4550 : color,
    emissiveIntensity: isFlutter || isAvnrt ? 0.1 : 0.12,
    transparent: true,
    opacity: isFlutter ? 0.45 : isAccessory || isAvnrt ? 0.55 : 0.95,
    depthWrite: isFlutter || isAvnrt ? false : true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = spec.name;
  mesh.userData.segmentId = spec.id;
  mesh.userData.segmentName = spec.name;
  mesh.userData.segmentDetail = spec.detail;
  mesh.userData.isConduction = true;
  mesh.userData.baseEmissive = isFlutter || isAvnrt ? 0.1 : 0.12;
  mesh.userData.curve = curve;
  mesh.userData.pathPoints = spec.points;
  if (isAvnrt) {
    mesh.renderOrder = 3; // above translucent AV halo
  }
  return mesh;
}

function createNode(
  position: [number, number, number],
  radius: number,
  color: number,
  name: string,
  detail: string,
  id: SegmentId,
): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.3,
    metalness: 0.1,
    emissive: color,
    emissiveIntensity: 0.4,
    transparent: true,
    opacity: 0.95,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 16), mat);
  mesh.position.set(...position);
  mesh.name = name;
  mesh.userData.segmentId = id;
  mesh.userData.segmentName = name;
  mesh.userData.segmentDetail = detail;
  mesh.userData.isConduction = true;
  mesh.userData.baseEmissive = 0.4;
  return mesh;
}

/** Pie-slice sphere whose wedges mirror every branch that meets at this point. */
function createMultiColorJunction(
  position: [number, number, number],
  radius: number,
  wedges: { color: number; id: SegmentId }[],
  name: string,
  detail: string,
): THREE.Group {
  const group = new THREE.Group();
  group.position.set(...position);
  group.name = name;
  group.userData.isJunction = true;
  group.userData.segmentIds = wedges.map((w) => w.id);
  group.userData.segmentName = name;
  group.userData.segmentDetail = detail;
  group.userData.isConduction = true;
  group.userData.junctionRadius = radius;

  const n = Math.max(1, wedges.length);
  wedges.forEach((w, i) => {
    const phi0 = (i / n) * Math.PI * 2 + Math.PI * 0.15;
    const phiLen = (Math.PI * 2) / n;
    const mat = new THREE.MeshStandardMaterial({
      color: w.color,
      roughness: 0.3,
      metalness: 0.1,
      emissive: w.color,
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.95,
    });
    const sliceGeo = new THREE.SphereGeometry(radius, 14, 12, phi0, phiLen);
    const mesh = new THREE.Mesh(sliceGeo, mat);
    mesh.userData.segmentId = w.id;
    mesh.userData.segmentName = name;
    mesh.userData.segmentDetail = detail;
    mesh.userData.isConduction = true;
    mesh.userData.isJunctionWedge = true;
    mesh.userData.baseEmissive = 0.4;
    mesh.userData.sliceGeo = sliceGeo;
    mesh.userData.fullGeo = new THREE.SphereGeometry(radius, 20, 16);
    group.add(mesh);
  });
  return group;
}

/**
 * Myocardial vector-field ellipsoid (must stay in sync with activationVectors.ts):
 *   (x/rx)² + ((y - cy)/ry)² + (z/rz)² ≤ limit
 */
export const FIELD_ELLIPSOID = {
  center: new THREE.Vector3(0, -0.15, 0),
  radius: new THREE.Vector3(1.05, 1.15, 0.95),
  limit: 0.95,
} as const;

/** Translucent cardiac ovoid — matches the vector-field ellipsoid bounds. */
function createHeartShell(): THREE.Group {
  const group = new THREE.Group();
  group.name = "heartShell";

  const { center, radius, limit } = FIELD_ELLIPSOID;
  const s = Math.sqrt(limit);

  const ovoid = new THREE.Mesh(
    new THREE.SphereGeometry(1, 48, 36),
    new THREE.MeshStandardMaterial({
      color: 0x5a3038,
      roughness: 0.65,
      metalness: 0.0,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ovoid.name = "heartBody";
  ovoid.position.copy(center);
  // Same axes as the field sample ellipsoid (slightly outside via tiny pad)
  ovoid.scale.set(radius.x * s * 1.02, radius.y * s * 1.02, radius.z * s * 1.02);
  group.add(ovoid);

  return group;
}

/** Keep shell locked to the field ellipsoid (pathways are authored inside that volume). */
function fitHeartShellToPathways(heartShell: THREE.Group, _pathways: THREE.Object3D): void {
  const ovoid = heartShell.getObjectByName("heartBody") as THREE.Mesh | undefined;
  if (!ovoid) return;
  const { center, radius, limit } = FIELD_ELLIPSOID;
  const s = Math.sqrt(limit);
  ovoid.position.copy(center);
  ovoid.scale.set(radius.x * s * 1.02, radius.y * s * 1.02, radius.z * s * 1.02);
}

/**
 * In-chest physiologic pose: long axis oblique with apex left, inferior, and anterior.
 * Authored apex is the −Y pole; negative X rotation tips −Y toward +Z (anterior).
 */
export function applyAnatomicOrientation(target: THREE.Object3D): void {
  target.rotation.order = "ZYX";
  // Less roll than a full side-lie so the long axis still reads inferiorly
  target.rotation.z = THREE.MathUtils.degToRad(ANATOMIC_EULER_DEG.z); // toward patient's left
  target.rotation.x = THREE.MathUtils.degToRad(ANATOMIC_EULER_DEG.x); // tip apex anteriorly
  target.rotation.y = THREE.MathUtils.degToRad(ANATOMIC_EULER_DEG.y);
}

function createPulseSprite(radius = 0.05, color = 0xffffff): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 10), mat);
  mesh.name = "pulse";
  mesh.visible = false;
  return mesh;
}

export type ConductionSystem = {
  root: THREE.Group;
  heartShell: THREE.Group;
  pulse: THREE.Mesh;
  setSegmentActive: (opts: {
    active: SegmentId[];
    tCycle: number;
    finding?: string;
    mark?: string;
    branches?: import("./pathwayTiming").BranchWindow[];
    intensity?: number;
  }) => void;
  updateImpulse: (opts: {
    tCycle: number;
    active: SegmentId[];
    finding?: string;
    mark?: string;
    branches?: import("./pathwayTiming").BranchWindow[];
  }) => void;
  getPathwayProbes: () => PathwayProbePoint[];
  /** World-space anchor for a nodal landmark (after model centering). */
  getLandmarkWorld: (id: "sa" | "av") => THREE.Vector3;
  getActiveFronts: (opts: {
    tCycle: number;
    finding?: string;
    mark?: string;
    branches?: import("./pathwayTiming").BranchWindow[];
  }) => import("./pathwayTiming").ActiveFront[];
  setSegmentVisibility: (id: SegmentId, visible: boolean) => void;
  setAccessoryVisible: (visible: boolean, side?: "left" | "right" | "both") => void;
  /** Enlarge / translucify AV node when dual pathways are shown (AVNRT). */
  setAvNodeEmphasis: (emphasized: boolean) => void;
  /** Highlight AV-nodal (supra-His) vs infra-His block level */
  setBlockSite: (site: "none" | "supra-his" | "infra-his") => void;
  /** Place lesion markers on blocked bundle / fascicle segments */
  setBranchBlocks: (segmentIds: SegmentId[]) => void;
  updateBlockSitePulse: (timeSec: number) => void;
  resetGlow: () => void;
};

type CurveEntry = {
  id: SegmentId;
  curve: THREE.CatmullRomCurve3;
  color: number;
};

export function createConductionSystem(): ConductionSystem {
  const root = new THREE.Group();
  root.name = "conductionSystem";

  const heartShell = createHeartShell();
  root.add(heartShell);

  const pathways = new THREE.Group();
  pathways.name = "pathways";

  const curveEntries: CurveEntry[] = [];
  const curvesBySegment = new Map<SegmentId, THREE.CatmullRomCurve3[]>();

  function isVentricularSeg(id: SegmentId): boolean {
    return (
      id === "his" ||
      id === "rbb" ||
      id === "lbb" ||
      id === "lbba" ||
      id === "lbbp" ||
      id === "purkinjeR" ||
      id === "purkinjeL" ||
      id === "myocardiumV"
    );
  }
  for (const path of PATHS) {
    const mesh = createPathMesh(path);
    pathways.add(mesh);
    const curve = mesh.userData.curve as THREE.CatmullRomCurve3;
    const list = curvesBySegment.get(path.id) ?? [];
    mesh.userData.curveIndex = list.length;
    list.push(curve);
    curvesBySegment.set(path.id, list);
    curveEntries.push({ id: path.id, curve, color: SEGMENT_COLORS[path.id] });
  }

  const saMain = createNode(SA, 0.055, SEGMENT_COLORS.sa, "SA node", "SVC–RA junction · primary pacemaker", "sa");
  const saSup = createNode(
    [-0.48, 0.68, 0.18],
    0.032,
    SEGMENT_COLORS.sa,
    "SA node (superior pole)",
    "Superior extent along sulcus terminalis",
    "sa",
  );
  const saInf = createNode(
    [-0.55, 0.48, 0.28],
    0.028,
    SEGMENT_COLORS.sa,
    "SA node (inferior pole)",
    "Inferior extent along sulcus terminalis",
    "sa",
  );
  const avNode = createNode(
    AV,
    AV_R,
    SEGMENT_COLORS.av,
    "AV node",
    "Triangle of Koch · compact node · delay & filter",
    "av",
  );

  // Larger translucent halo — dual pathways wrap on this surface during AVNRT
  const avHalo = new THREE.Mesh(
    new THREE.SphereGeometry(AV_HALO_R, 32, 24),
    new THREE.MeshStandardMaterial({
      color: SEGMENT_COLORS.av,
      roughness: 0.45,
      metalness: 0.05,
      emissive: SEGMENT_COLORS.av,
      emissiveIntensity: 0.12,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  avHalo.name = "AV node halo";
  avHalo.position.set(...AV);
  avHalo.visible = false;
  avHalo.userData.isAvHalo = true;
  avHalo.userData.isConduction = false;
  avHalo.renderOrder = 1;

  // Multicolor junction beads — hide tube end-caps / color seams at branch points
  const junctions: THREE.Group[] = [
    createMultiColorJunction(
      HIS_PEN,
      0.038,
      [
        { color: SEGMENT_COLORS.his, id: "his" },
        { color: 0x9aa4ae, id: "avnrtSlow" },
        { color: 0xb0b8c0, id: "avnrtFast" },
      ],
      "His / AVN loop junction",
      "Penetrating His meets slow & fast pathways",
    ),
    createMultiColorJunction(
      HIS_BRANCH,
      0.036,
      [
        { color: SEGMENT_COLORS.his, id: "his" },
        { color: SEGMENT_COLORS.rbb, id: "rbb" },
        { color: SEGMENT_COLORS.lbb, id: "lbb" },
      ],
      "His bifurcation",
      "Crest of muscular IV septum · His → RBB / LBB",
    ),
    createMultiColorJunction(
      LBB_ORIGIN,
      0.034,
      [
        { color: SEGMENT_COLORS.lbb, id: "lbb" },
        { color: SEGMENT_COLORS.lbba, id: "lbba" },
        { color: SEGMENT_COLORS.lbbp, id: "lbbp" },
      ],
      "Left bundle fan",
      "LBB cascade → anterior / posterior / septal fascicles",
    ),
    createMultiColorJunction(
      LAF_TIP,
      0.02,
      [
        { color: SEGMENT_COLORS.lbba, id: "lbba" },
        { color: SEGMENT_COLORS.purkinjeL, id: "purkinjeL" },
      ],
      "LAF–Purkinje junction",
      "Left anterior fascicle → LV anterolateral Purkinje",
    ),
    createMultiColorJunction(
      LPF_TIP,
      0.02,
      [
        { color: SEGMENT_COLORS.lbbp, id: "lbbp" },
        { color: SEGMENT_COLORS.purkinjeL, id: "purkinjeL" },
      ],
      "LPF–Purkinje junction",
      "Left posterior fascicle → LV inferior Purkinje",
    ),
    createMultiColorJunction(
      SEPTAL_TIP,
      0.018,
      [
        { color: SEGMENT_COLORS.lbb, id: "lbb" },
        { color: SEGMENT_COLORS.purkinjeL, id: "purkinjeL" },
      ],
      "Septal–Purkinje junction",
      "Left septal fascicle → LV septal Purkinje",
    ),
    createMultiColorJunction(
      RBB_APEX,
      0.022,
      [
        { color: SEGMENT_COLORS.rbb, id: "rbb" },
        { color: SEGMENT_COLORS.purkinjeR, id: "purkinjeR" },
      ],
      "RBB–Purkinje junction",
      "Right bundle → RV Purkinje network",
    ),
    createMultiColorJunction(
      MOD_BAND_END,
      0.02,
      [
        { color: SEGMENT_COLORS.rbb, id: "rbb" },
        { color: SEGMENT_COLORS.purkinjeR, id: "purkinjeR" },
      ],
      "Moderator band insertion",
      "Moderator band → anterior papillary / Purkinje",
    ),
    createMultiColorJunction(
      ACC_L_LA,
      0.018,
      [{ color: SEGMENT_COLORS.accessory, id: "accessory" }],
      "Left Kent atrial insertion",
      "Left-lateral LA · basal/outside mitral annulus",
    ),
    createMultiColorJunction(
      ACC_L_EPIC,
      0.014,
      [{ color: SEGMENT_COLORS.accessory, id: "accessory" }],
      "Left Kent epicardial bridge",
      "AV-groove fat pad · lateral to fibrous mitral ring",
    ),
    createMultiColorJunction(
      PURK_L_ANT_BASE_TIP,
      0.02,
      [
        { color: SEGMENT_COLORS.accessory, id: "accessory" },
        { color: SEGMENT_COLORS.purkinjeL, id: "purkinjeL" },
      ],
      "Left Kent–Purkinje tip",
      "Left-lateral Kent meets LV anterolateral Purkinje · base tip",
    ),
    createMultiColorJunction(
      ACC_R_LA,
      0.018,
      [{ color: SEGMENT_COLORS.accessoryR, id: "accessoryR" }],
      "Right Kent atrial insertion",
      "Right-lateral RA · outside tricuspid annulus",
    ),
    createMultiColorJunction(
      ACC_R_EPIC,
      0.014,
      [{ color: SEGMENT_COLORS.accessoryR, id: "accessoryR" }],
      "Right Kent epicardial bridge",
      "AV-groove fat pad · lateral to fibrous tricuspid ring",
    ),
    createMultiColorJunction(
      PURK_R_FW_SUP_TIP,
      0.02,
      [
        { color: SEGMENT_COLORS.accessoryR, id: "accessoryR" },
        { color: SEGMENT_COLORS.purkinjeR, id: "purkinjeR" },
      ],
      "Right Kent–Purkinje tip",
      "Right-lateral Kent meets RV free-wall Purkinje · superior tip",
    ),
  ];

  pathways.add(saMain, saSup, saInf, avNode, avHalo, ...junctions);
  root.add(pathways);

  const segmentVis: Partial<Record<SegmentId, boolean>> = {};
  for (const g of SEGMENT_META) segmentVis[g.id] = g.defaultOn;

  // Animated “block level” markers (supra-His vs infra-His)
  const blockSiteGroup = new THREE.Group();
  blockSiteGroup.name = "blockSite";
  blockSiteGroup.visible = false;

  function makeBlockMarker(color: number, label: string, tangent: [number, number, number]): THREE.Group {
    const g = new THREE.Group();
    const n = new THREE.Vector3(...tangent).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);

    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.1, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.45,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    disc.setRotationFromQuaternion(quat);
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(0.09, 0.11, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffe8ec,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    rim.setRotationFromQuaternion(quat);
    g.add(disc, rim);

    const hatch = new THREE.Mesh(
      new THREE.PlaneGeometry(0.14, 0.014),
      new THREE.MeshBasicMaterial({
        color: 0xfff6f8,
        transparent: true,
        opacity: 0.95,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    hatch.setRotationFromQuaternion(quat);
    g.add(hatch);
    const hatch2 = hatch.clone();
    hatch2.rotateZ(Math.PI / 2);
    g.add(hatch2);

    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 64);
    ctx.font = "600 26px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#e8eef2";
    ctx.fillText(label, 128, 32);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    sprite.scale.set(0.55, 0.14, 1);
    sprite.position.set(0.2, 0.08, 0.05);
    g.add(sprite);
    return g;
  }

  // Plane normals ≈ conduction direction at the block level
  const supraMarker = makeBlockMarker(0xff7a4a, "Block · supra-His", [0.15, -0.9, 0.2]);
  supraMarker.position.set(...AV);
  supraMarker.position.y += 0.02;
  const infraMarker = makeBlockMarker(0xff5e6c, "Block · infra-His", [0.05, -0.95, 0.15]);
  infraMarker.position.set(...HIS_PEN);
  blockSiteGroup.add(supraMarker, infraMarker);
  root.add(blockSiteGroup);

  let blockSiteMode: "none" | "supra-his" | "infra-his" = "none";

  function setBlockSite(site: "none" | "supra-his" | "infra-his") {
    blockSiteMode = site;
    blockSiteGroup.visible = site !== "none";
    supraMarker.visible = site === "supra-his";
    infraMarker.visible = site === "infra-his";
  }

  const branchLesionGroup = new THREE.Group();
  branchLesionGroup.name = "branchLesions";
  root.add(branchLesionGroup);

  function makeBranchLesionMarker(color: number, label: string, tangent: THREE.Vector3): THREE.Group {
    const g = new THREE.Group();

    // Thin disc cutting across the conduction tract (normal ≈ travel direction)
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.09, 28),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.42,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(0.082, 0.098, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffe8ec,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    // Default CircleGeometry faces +Z; aim +Z along pathway tangent
    const n = tangent.clone().normalize();
    if (n.lengthSq() < 1e-8) n.set(0, 1, 0);
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    disc.setRotationFromQuaternion(quat);
    rim.setRotationFromQuaternion(quat);
    g.add(disc, rim);

    // Small hatch on the plane to read as a “cut”
    const hatch = new THREE.Mesh(
      new THREE.PlaneGeometry(0.12, 0.012),
      new THREE.MeshBasicMaterial({
        color: 0xfff6f8,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    hatch.setRotationFromQuaternion(quat);
    g.add(hatch);
    const hatch2 = hatch.clone();
    hatch2.rotateZ(Math.PI / 2);
    g.add(hatch2);

    const canvas = document.createElement("canvas");
    canvas.width = 192;
    canvas.height = 48;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, 192, 48);
    ctx.font = "600 22px Outfit, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f0e6e8";
    ctx.fillText(label, 96, 24);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    sprite.scale.set(0.42, 0.11, 1);
    sprite.position.copy(n.clone().multiplyScalar(0.02)).add(new THREE.Vector3(0.12, 0.05, 0));
    g.add(sprite);
    return g;
  }

  const LESION_LABEL: Partial<Record<SegmentId, string>> = {
    rbb: "Block · RBB",
    lbb: "Block · LBB",
    lbba: "Block · LAF",
    lbbp: "Block · LPF",
  };

  function setBranchBlocks(segmentIds: SegmentId[]) {
    while (branchLesionGroup.children.length) {
      branchLesionGroup.remove(branchLesionGroup.children[0]!);
    }
    const unique = [...new Set(segmentIds)];
    for (const id of unique) {
      const curves = curvesBySegment.get(id);
      if (!curves?.length) continue;
      // Proximal lesion on primary tract
      const u = 0.22;
      const curve = curves[0]!;
      const pt = curve.getPointAt(u);
      const tangent = curve.getTangentAt(u).normalize();
      const marker = makeBranchLesionMarker(
        SEGMENT_COLORS[id] ?? 0xff6680,
        LESION_LABEL[id] ?? `Block · ${id}`,
        tangent,
      );
      marker.position.copy(pt);
      branchLesionGroup.add(marker);

      // Dim proximal pathway meshes for this segment
      pathways.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        if (obj.userData.segmentId !== id) return;
        const mat = obj.material;
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.color.setHex(0x4a5058);
          mat.emissive.setHex(0x2a1018);
          mat.emissiveIntensity = 0.2;
          mat.opacity = 0.45;
          mat.transparent = true;
          obj.userData.lesioned = true;
        }
      });
    }
    // Restore non-lesioned pathways that may have been dimmed previously
    pathways.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const id = obj.userData.segmentId as SegmentId | undefined;
      if (!id || unique.includes(id)) return;
      if (!obj.userData.lesioned) return;
      obj.userData.lesioned = false;
      const mat = obj.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.color.setHex(SEGMENT_COLORS[id] ?? 0xffffff);
        mat.emissive.setHex(SEGMENT_COLORS[id] ?? 0xffffff);
        mat.emissiveIntensity = Number(obj.userData.baseEmissive ?? 0.12);
        mat.opacity = id === "accessory" || id === "accessoryR" || id === "avnrtSlow" || id === "avnrtFast" ? 0.55 : id === "flutter" ? 0.45 : 1;
        mat.transparent = id === "accessory" || id === "accessoryR" || id === "flutter" || id === "avnrtSlow" || id === "avnrtFast";
      }
    });
    branchLesionGroup.visible = unique.length > 0;
  }

  function updateBlockSitePulse(timeSec: number) {
    if (blockSiteMode === "none" && branchLesionGroup.children.length === 0) return;
    if (blockSiteMode !== "none") {
      const m = blockSiteMode === "supra-his" ? supraMarker : infraMarker;
      const pulse = 0.85 + 0.15 * Math.sin(timeSec * 4.2);
      m.scale.setScalar(pulse);
      m.traverse((obj) => {
        if (obj instanceof THREE.Mesh && obj.material instanceof THREE.MeshBasicMaterial) {
          obj.material.opacity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(timeSec * 5));
        }
      });
    }
    for (let i = 0; i < branchLesionGroup.children.length; i++) {
      const child = branchLesionGroup.children[i]!;
      const pulse = 0.9 + 0.12 * Math.sin(timeSec * 4.5 + i);
      child.scale.setScalar(pulse);
    }
  }

  const guides = new THREE.Group();
  guides.name = "anatomyGuides";
  for (const g of ANATOMY_GUIDES) {
    guides.add(createGuideMesh(g));
  }
  root.add(guides);

  // Pool of pulses for parallel branch fronts
  const PULSE_POOL = 28;
  const pulsePool: THREE.Mesh[] = [];
  for (let i = 0; i < PULSE_POOL; i++) {
    const p = createPulseSprite(i === 0 ? 0.052 : 0.038);
    pulsePool.push(p);
    root.add(p);
  }
  const pulse = pulsePool[0]!;

  function resetGlow() {
    pathways.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material;
      if (!(mat instanceof THREE.MeshStandardMaterial)) return;
      const base = Number(obj.userData.baseEmissive ?? 0.12);
      let intensity = base;
      if (obj.userData.hovered) intensity = Math.max(intensity, 1.15);
      mat.emissiveIntensity = intensity;
      if (obj.userData.segmentId === "accessory" || obj.userData.segmentId === "accessoryR") mat.opacity = 0.55;
      if (obj.userData.segmentId === "flutter") mat.opacity = 0.45;
      if (obj.userData.segmentId === "avnrtSlow" || obj.userData.segmentId === "avnrtFast") {
        mat.color.setHex(0x9aa4ae);
        mat.emissive.setHex(0x3a4550);
        mat.opacity = 0.55;
        obj.userData.avnrtState = "rest";
      }
    });
  }

  /**
   * Light segments that are conducting now, and keep a softer afterglow
   * through their refractory period until they can activate again.
   */
  /**
   * Drive pathway emissive glow. Ventricular tracts only light during QRS/ST/T
   * (or when EKG explicitly lists them) so atrial marks can't leave the ventricles lit.
   */
  function setSegmentActive(opts: {
    active: SegmentId[];
    tCycle: number;
    finding?: string;
    mark?: string;
    branches?: import("./pathwayTiming").BranchWindow[];
    intensity?: number;
  }) {
    const peak = opts.intensity ?? 0.95;
    const branches = opts.branches ?? branchesForFinding(opts.finding);
    const ekgActive = new Set(opts.active);
    const mark = opts.mark ?? "TP";
    const ventPhase = mark === "QRS" || mark === "ST" || mark === "T";

    pathways.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material;
      if (!(mat instanceof THREE.MeshStandardMaterial)) return;

      const id = obj.userData.segmentId as SegmentId | undefined;
      if (!id) return;

      const base = Number(obj.userData.baseEmissive ?? 0.12);
      const ci =
        typeof obj.userData.curveIndex === "number" ? obj.userData.curveIndex : undefined;
      let glow = refractoryGlow(opts.tCycle, branches, id, ci);

      // AFib: SA node is not the pacemaker — keep it visually quenched
      if (id === "sa") {
        if (opts.finding === "afib") {
          mat.emissiveIntensity = 0.03;
          mat.opacity = 0.32;
          return;
        }
        mat.opacity = 0.95;
      }

      // Schedule alone must not light ventricles during atrial / idle marks
      if (isVentricularSeg(id) && !ventPhase && !ekgActive.has(id)) glow = 0;

      let intensity = base;
      if (glow >= 0.95 || ekgActive.has(id)) {
        intensity = peak;
      } else if (glow > 0) {
        intensity = base + (0.48 - base) * (glow / 0.55);
      }

      if (id === "accessory" || id === "accessoryR") {
        mat.opacity = glow > 0 || ekgActive.has(id) ? 0.95 : 0.55;
      }
      if (id === "flutter") {
        mat.opacity = glow > 0 || ekgActive.has(id) ? 0.7 : 0.45;
      }
      if ((id === "avnrtSlow" || id === "avnrtFast") && !obj.userData.isJunctionWedge) {
        // Conducting vs refractory (inhibited) vs resting — pulse the limb itself
        if (glow >= 0.95 || ekgActive.has(id)) {
          mat.color.setHex(0xe8eef4);
          mat.emissive.setHex(0xc8d4e0);
          mat.opacity = 0.95;
          intensity = peak;
          obj.userData.avnrtState = "conducting";
        } else if (glow > 0) {
          const pulse = 0.5 + 0.5 * Math.sin(opts.tCycle * Math.PI * 1.6);
          mat.color.setHex(0xe07050);
          mat.emissive.setHex(0xb03820);
          mat.opacity = 0.55 + 0.4 * pulse;
          intensity = 0.4 + 0.55 * pulse;
          obj.userData.avnrtState = "refractory";
        } else {
          mat.color.setHex(0x9aa4ae);
          mat.emissive.setHex(0x3a4550);
          mat.opacity = 0.55;
          obj.userData.avnrtState = "rest";
        }
      }
      if (obj.userData.hovered) intensity = Math.max(intensity, 1.15);
      mat.emissiveIntensity = intensity;
    });
  }

  function pointOnSegment(id: SegmentId, u: number, curveIndex = 0): THREE.Vector3 | null {
    const curves = curvesBySegment.get(id);
    if (!curves?.length) {
      if (id === "sa") return new THREE.Vector3(...SA);
      if (id === "av") return new THREE.Vector3(...AV);
      return null;
    }
    const curve = curves[Math.min(curveIndex, curves.length - 1)]!;
    return curve.getPointAt(THREE.MathUtils.clamp(u, 0, 1), new THREE.Vector3());
  }

  function travelOnSegment(
    id: SegmentId,
    u: number,
    uEnd: number,
    curveIndex = 0,
  ): THREE.Vector3 | null {
    const curves = curvesBySegment.get(id);
    if (!curves?.length) {
      if (id === "sa") return new THREE.Vector3(0.4, -0.5, -0.2).normalize();
      if (id === "av") return new THREE.Vector3(0.1, -0.9, 0.1).normalize();
      return null;
    }
    const curve = curves[Math.min(curveIndex, curves.length - 1)]!;
    return travelDirAt(curve, u, uEnd);
  }

  /**
   * Impulse fronts for every branch window active at tCycle, with travel direction
   * (respects reverse / u0–u1 so CW flutter and retrograde tracts point correctly).
   */
  function getActiveFronts(opts: {
    tCycle: number;
    finding?: string;
    mark?: string;
    branches?: import("./pathwayTiming").BranchWindow[];
  }): import("./pathwayTiming").ActiveFront[] {
    const t = ((opts.tCycle % 1) + 1) % 1;
    const branches = opts.branches ?? branchesForFinding(opts.finding);
    const mark = opts.mark ?? "TP";
    const ventPhase = mark === "QRS" || mark === "ST" || mark === "T";
    const out: import("./pathwayTiming").ActiveFront[] = [];

    for (const b of branches) {
      // Hold the front at the tip briefly so vectors finish the tract instead of
      // vanishing the frame they reach u=1 (noticeable on short fascicle windows).
      const tipHold = 0.04;
      if (t < b.t0 || t > b.t1 + tipHold) continue;
      if (!ventPhase && isVentricularSeg(b.id)) continue;
      const span = Math.max(1e-4, b.t1 - b.t0);
      const progress = Math.min(1, (t - b.t0) / span);
      const uStart = b.u0 ?? (b.reverse ? 1 : 0);
      const uEnd = b.u1 ?? (b.reverse ? 0 : 1);
      const u = uStart + (uEnd - uStart) * progress;
      const curves = curvesBySegment.get(b.id);
      const color = SEGMENT_COLORS[b.id];
      const isReverse = !!b.reverse || uEnd < uStart;

      const pushFrontAt = (curveIndex: number) => {
        const pt = pointOnSegment(b.id, u, curveIndex);
        const dir = travelOnSegment(b.id, u, uEnd, curveIndex);
        if (!pt || !dir) return;
        out.push({
          id: b.id,
          pos: [pt.x, pt.y, pt.z],
          dir: [dir.x, dir.y, dir.z],
          color,
          progress,
          reverse: isReverse,
        });
      };

      if (!curves?.length) {
        if (b.id === "sa" || b.id === "av") pushFrontAt(0);
        continue;
      }

      // Match impulse pulses: every anatomic curve of this segment gets its own front
      // (internodals, both His parts, RBB+moderator, fascicles, all Purkinje branches).
      if (b.curveIndex != null) pushFrontAt(b.curveIndex);
      else {
        for (let ci = 0; ci < curves.length; ci++) pushFrontAt(ci);
      }
    }
    return out;
  }

  function getPathwayProbes(): PathwayProbePoint[] {
    const branches = branchesForFinding("nsr");
    const timing = new Map<SegmentId, { t0: number; t1: number }>();
    for (const b of branches) {
      const prev = timing.get(b.id);
      if (!prev) timing.set(b.id, { t0: b.t0, t1: b.t1 });
      else timing.set(b.id, { t0: Math.min(prev.t0, b.t0), t1: Math.max(prev.t1, b.t1) });
    }

    const probes: PathwayProbePoint[] = [];
    const samplesPerCurve = 24;

    for (const entry of curveEntries) {
      const win = timing.get(entry.id) ?? { t0: 0.3, t1: 0.5 };
      for (let i = 0; i <= samplesPerCurve; i++) {
        const u = i / samplesPerCurve;
        const pos = entry.curve.getPointAt(u);
        const tan = travelDirAt(entry.curve, u, 1);
        probes.push({
          pos: [pos.x, pos.y, pos.z],
          tangent: [tan.x, tan.y, tan.z],
          segmentId: entry.id,
          color: entry.color,
          pathU: u,
          enterT: win.t0,
          exitT: win.t1,
        });
      }
    }

    // Node anchors
    probes.push({
      pos: [...SA],
      tangent: [0.4, -0.5, -0.2],
      segmentId: "sa",
      color: SEGMENT_COLORS.sa,
      pathU: 0,
      enterT: 0.05,
      exitT: 0.09,
    });
    probes.push({
      pos: [...AV],
      tangent: [0.1, -0.9, 0.1],
      segmentId: "av",
      color: SEGMENT_COLORS.av,
      pathU: 0.5,
      enterT: 0.17,
      exitT: 0.28,
    });

    return probes;
  }

  function updateImpulse(opts: {
    tCycle: number;
    active: SegmentId[];
    finding?: string;
    mark?: string;
    branches?: import("./pathwayTiming").BranchWindow[];
  }) {
    const t = ((opts.tCycle % 1) + 1) % 1;
    const branches = opts.branches ?? branchesForFinding(opts.finding);
    const activeSet = new Set(opts.active);
    const mark = opts.mark ?? "TP";
    const ventPhase = mark === "QRS" || mark === "ST" || mark === "T";

    type Front = {
      id: SegmentId;
      curveIndex: number;
      u: number;
      color: number;
    };
    const fronts: Front[] = [];

    for (const b of branches) {
      if (t < b.t0 || t > b.t1) continue;
      if (!ventPhase && isVentricularSeg(b.id)) continue;
      const uRaw = (t - b.t0) / Math.max(1e-4, b.t1 - b.t0);
      const uStart = b.u0 ?? (b.reverse ? 1 : 0);
      const uEnd = b.u1 ?? (b.reverse ? 0 : 1);
      const u = uStart + (uEnd - uStart) * uRaw;
      const curves = curvesBySegment.get(b.id);

      if (!curves?.length) {
        if (b.id === "sa" || b.id === "av") {
          fronts.push({
            id: b.id,
            curveIndex: 0,
            u,
            color: SEGMENT_COLORS[b.id],
          });
        }
        continue;
      }

      if (b.curveIndex != null) {
        fronts.push({
          id: b.id,
          curveIndex: b.curveIndex,
          u,
          color: SEGMENT_COLORS[b.id],
        });
      } else {
        // All parallel tracts of this segment (e.g. three internodal + Bachmann)
        for (let ci = 0; ci < curves.length; ci++) {
          fronts.push({
            id: b.id,
            curveIndex: ci,
            u,
            color: SEGMENT_COLORS[b.id],
          });
        }
      }
    }

    // Hide unused pool slots
    for (const p of pulsePool) p.visible = false;

    if (!fronts.length) {
      // Soft hold on last active node if EKG says something is lit
      if (activeSet.has("av")) {
        pulse.visible = true;
        pulse.position.set(...AV);
        if (pulse.material instanceof THREE.MeshBasicMaterial) {
          pulse.material.color.setHex(SEGMENT_COLORS.av);
        }
      }
      return;
    }

    for (let i = 0; i < fronts.length && i < pulsePool.length; i++) {
      const f = fronts[i]!;
      const mesh = pulsePool[i]!;
      const pt = pointOnSegment(f.id, f.u, f.curveIndex);
      if (!pt) {
        if (f.id === "sa") {
          mesh.visible = true;
          mesh.position.set(...SA);
        } else if (f.id === "av") {
          mesh.visible = true;
          mesh.position.set(...AV);
        }
      } else {
        mesh.visible = true;
        mesh.position.copy(pt);
      }
      mesh.scale.setScalar(i < 3 ? 1.15 : 0.9);
      if (mesh.material instanceof THREE.MeshBasicMaterial) {
        // Flutter circuit is thin grey — keep pulse bright so the lap is followable
        mesh.material.color.setHex(f.id === "flutter" ? 0xe8f0f4 : f.color);
        mesh.material.opacity = activeSet.has(f.id) || activeSet.size === 0 ? 0.95 : 0.7;
      }
    }
  }

  function setSegmentVisibility(id: SegmentId, visible: boolean) {
    segmentVis[id] = visible;
    pathways.traverse((obj) => {
      if (obj.userData.isJunction || obj.userData.isJunctionWedge || obj.userData.isAvHalo) return;
      if (obj.userData.segmentId === id) obj.visible = visible;
    });
    for (const j of junctions) {
      const ids = (j.userData.segmentIds as SegmentId[]) ?? [];
      const kentLeft = ids.includes("accessory");
      const kentRight = ids.includes("accessoryR");
      // Kent tip beads include Purkinje wedges — hide the whole bead unless that Kent is on
      if (kentLeft || kentRight) {
        const kentOn =
          (kentLeft && !!segmentVis.accessory) || (kentRight && !!segmentVis.accessoryR);
        j.visible = kentOn;
        for (const child of j.children) {
          if (child instanceof THREE.Mesh && child.userData.isJunctionWedge) {
            child.visible = kentOn && !!segmentVis[child.userData.segmentId as SegmentId];
          }
        }
        continue;
      }

      const live: THREE.Mesh[] = [];
      for (const child of j.children) {
        if (!(child instanceof THREE.Mesh) || !child.userData.isJunctionWedge) continue;
        const on = !!segmentVis[child.userData.segmentId as SegmentId];
        child.visible = on;
        if (on) live.push(child);
      }
      j.visible = live.length > 0;
      // One live branch → full bead; several → pie wedges of each color
      for (const m of live) {
        const geo = live.length === 1 ? m.userData.fullGeo : m.userData.sliceGeo;
        if (geo && m.geometry !== geo) m.geometry = geo;
      }
    }
  }

  function setAccessoryVisible(visible: boolean, side: "left" | "right" | "both" = "both") {
    if (side === "left" || side === "both") setSegmentVisibility("accessory", visible);
    if (side === "right" || side === "both") setSegmentVisibility("accessoryR", visible);
  }

  function setAvNodeEmphasis(emphasized: boolean) {
    // Core AV stays solid; translucent halo + grey wraps appear for AVNRT
    avHalo.visible = emphasized;
    if (avNode.material instanceof THREE.MeshStandardMaterial) {
      avNode.material.opacity = 0.95;
      avNode.material.transparent = true;
      avNode.material.depthWrite = true;
    }
  }

  resetGlow();
  for (const g of SEGMENT_META) {
    setSegmentVisibility(g.id, g.defaultOn);
  }
  setAccessoryVisible(false);
  setSegmentVisibility("flutter", false);
  setSegmentVisibility("avnrtSlow", false);
  setSegmentVisibility("avnrtFast", false);
  setAvNodeEmphasis(false);

  // Wrap pathways snugly, then center the whole conduction root
  fitHeartShellToPathways(heartShell, pathways);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);

  function getLandmarkWorld(id: "sa" | "av"): THREE.Vector3 {
    const local = new THREE.Vector3(...(id === "av" ? AV : SA));
    root.updateMatrixWorld(true);
    return root.localToWorld(local);
  }

  return {
    root,
    heartShell,
    pulse,
    setSegmentActive,
    updateImpulse,
    getPathwayProbes,
    getLandmarkWorld,
    getActiveFronts,
    setSegmentVisibility,
    setAccessoryVisible,
    setAvNodeEmphasis,
    setBlockSite,
    setBranchBlocks,
    updateBlockSitePulse,
    resetGlow,
  };
}
