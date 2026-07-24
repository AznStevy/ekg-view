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
  { id: "avnrtSlow", label: "AVNRT slow pathway", color: "#5eb8d4", defaultOn: false },
  { id: "avnrtFast", label: "AVNRT fast pathway", color: "#ff8a5c", defaultOn: false },
  { id: "his", label: "Bundle of His", color: "#ff5e6c", defaultOn: true },
  { id: "rbb", label: "Right bundle", color: "#5ec8ff", defaultOn: true },
  { id: "lbb", label: "Left bundle", color: "#6ae0a8", defaultOn: true },
  { id: "lbba", label: "Left anterior fascicle", color: "#4ec890", defaultOn: true },
  { id: "lbbp", label: "Left posterior fascicle", color: "#3ab078", defaultOn: true },
  { id: "purkinjeR", label: "Purkinje (RV)", color: "#7ad4ff", defaultOn: true },
  { id: "purkinjeL", label: "Purkinje (LV)", color: "#88f0c0", defaultOn: true },
  { id: "accessory", label: "Accessory pathway", color: "#c070ff", defaultOn: false },
  { id: "myocardiumA", label: "Atrial myocardium", color: "#d08090", defaultOn: false },
  { id: "myocardiumV", label: "Ventricular myocardium", color: "#c06070", defaultOn: false },
];

const SEGMENT_COLORS: Record<SegmentId, number> = {
  sa: 0xf0c040,
  internodal: 0xe8a838,
  flutter: 0x8a9aa8,
  av: 0xff7a4a,
  avnrtSlow: 0x5eb8d4,
  avnrtFast: 0xff8a5c,
  his: 0xff5e6c,
  rbb: 0x5ec8ff,
  lbb: 0x6ae0a8,
  lbba: 0x4ec890,
  lbbp: 0x3ab078,
  purkinjeR: 0x7ad4ff,
  purkinjeL: 0x88f0c0,
  accessory: 0xc070ff,
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
};

type GuideSpec = {
  name: string;
  detail: string;
  points: [number, number, number][];
  radius?: number;
  tubularSegments?: number;
};

/** Thin grey anatomic landmarks (context only — not impulse pathways) */
const ANATOMY_GUIDES: GuideSpec[] = [
  {
    name: "Tricuspid annulus",
    detail: "RA–RV junction · flutter circuit boundary",
    radius: 0.007,
    tubularSegments: 64,
    points: [
      [-0.42, 0.08, 0.22],
      [-0.2, -0.02, 0.28],
      [0.05, -0.06, 0.18],
      [0.12, 0.05, -0.02],
      [0.02, 0.18, -0.18],
      [-0.2, 0.22, -0.12],
      [-0.4, 0.16, 0.05],
      [-0.42, 0.08, 0.22],
    ],
  },
  {
    name: "IVC–RA junction",
    detail: "Inferior vena cava orifice · CTI lateral margin",
    radius: 0.008,
    points: [
      [-0.35, -0.22, 0.05],
      [-0.42, -0.12, 0.12],
      [-0.48, -0.02, 0.18],
      [-0.4, 0.02, 0.1],
    ],
  },
  {
    name: "Coronary sinus ostium",
    detail: "Posteroseptal RA · near triangle of Koch",
    radius: 0.007,
    points: [
      [-0.12, -0.06, -0.22],
      [-0.06, -0.02, -0.18],
      [0.0, 0.02, -0.14],
      [0.04, 0.06, -0.1],
    ],
  },
  {
    name: "Eustachian ridge",
    detail: "IVC to CS · forms CTI posterior border",
    radius: 0.006,
    points: [
      [-0.45, -0.08, 0.08],
      [-0.32, -0.04, -0.02],
      [-0.18, -0.02, -0.12],
      [-0.08, 0.0, -0.16],
    ],
  },
  {
    name: "Fossa ovalis (septum)",
    detail: "Interatrial septum landmark",
    radius: 0.006,
    points: [
      [-0.05, 0.35, -0.08],
      [0.0, 0.28, -0.12],
      [0.02, 0.18, -0.14],
      [0.0, 0.08, -0.12],
    ],
  },
  {
    name: "SVC–RA junction",
    detail: "Superior vena cava · near SA node",
    radius: 0.008,
    points: [
      [-0.4, 0.78, 0.08],
      [-0.48, 0.68, 0.15],
      [-0.52, 0.58, 0.22],
      [-0.48, 0.5, 0.18],
    ],
  },
  {
    name: "Mitral annulus (guide)",
    detail: "LA–LV junction · anatomic reference",
    radius: 0.006,
    tubularSegments: 48,
    points: [
      [0.35, 0.12, -0.15],
      [0.48, 0.02, -0.05],
      [0.42, -0.12, 0.1],
      [0.22, -0.08, 0.18],
      [0.18, 0.08, 0.02],
      [0.28, 0.16, -0.1],
      [0.35, 0.12, -0.15],
    ],
  },
];

function createGuideMesh(spec: GuideSpec): THREE.Mesh {
  const curve = makeCurve(spec.points);
  const r = spec.radius ?? 0.007;
  const geo = createTaperedTubeGeometry(
    curve,
    spec.tubularSegments ?? 40,
    r,
    r * 0.85,
    6,
  );
  const mat = new THREE.MeshStandardMaterial({
    color: 0x7a8a96,
    roughness: 0.55,
    metalness: 0.05,
    emissive: 0x3a4550,
    emissiveIntensity: 0.08,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = spec.name;
  mesh.userData.segmentName = spec.name;
  mesh.userData.segmentDetail = spec.detail;
  mesh.userData.segmentId = "guide";
  mesh.userData.isConduction = false;
  mesh.userData.isAnatomyGuide = true;
  mesh.userData.baseEmissive = 0.08;
  return mesh;
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
const HIS_PEN: [number, number, number] = [0.04, -0.1, -0.08];
const HIS_BRANCH: [number, number, number] = [0.05, -0.28, -0.04];
const LBB_ORIGIN: [number, number, number] = [0.14, -0.34, 0.0];
const RBB_MID: [number, number, number] = [-0.08, -0.55, 0.18];
const RBB_APEX: [number, number, number] = [-0.18, -0.95, 0.32];
const MOD_BAND_END: [number, number, number] = [-0.48, -0.62, 0.48];

/** CTI flutter ring landmarks (RA around tricuspid annulus) */
const CTI_LAT: [number, number, number] = [-0.48, -0.02, 0.18];
const CTI_MED: [number, number, number] = [-0.06, 0.0, -0.14];
const SEPT_SUP: [number, number, number] = [0.06, 0.42, -0.16];
const ROOF_LAT: [number, number, number] = [-0.42, 0.62, 0.2];

/** Triangle of Koch · dual AV-nodal pathways (typical slow–fast AVNRT) */
const KOCH_CS: [number, number, number] = [-0.1, -0.06, -0.2];
const KOCH_SLOW_MID: [number, number, number] = [-0.05, -0.02, -0.16];
const KOCH_TODARO: [number, number, number] = [0.08, 0.16, -0.14];
const KOCH_FAST_MID: [number, number, number] = [0.04, 0.09, -0.13];
const KOCH_ATRIAL_EXIT: [number, number, number] = [0.02, 0.22, -0.1];

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
    tubularSegments: 48,
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

  // —— AVNRT dual pathways (triangle of Koch) ——
  {
    id: "avnrtSlow",
    name: "Slow pathway (posterior)",
    detail: "CS ostium / inferior Koch → compact AV node · typical AVNRT anterograde limb",
    radiusStart: 0.011,
    radiusEnd: 0.008,
    tubularSegments: 40,
    points: [
      KOCH_CS,
      [-0.08, -0.04, -0.18],
      KOCH_SLOW_MID,
      [-0.02, 0.0, -0.14],
      AV,
    ],
  },
  {
    id: "avnrtFast",
    name: "Fast pathway (anterior)",
    detail: "Tendon of Todaro / superior Koch → compact AV node · typical AVNRT retrograde limb",
    radiusStart: 0.01,
    radiusEnd: 0.008,
    tubularSegments: 40,
    points: [
      KOCH_TODARO,
      KOCH_FAST_MID,
      [0.02, 0.05, -0.125],
      AV,
    ],
  },
  {
    id: "avnrtFast",
    name: "Fast-pathway atrial exit",
    detail: "Retrograde exit toward atrial septum / superior approaches",
    radiusStart: 0.009,
    radiusEnd: 0.007,
    tubularSegments: 32,
    points: [
      AV,
      [0.03, 0.1, -0.12],
      KOCH_ATRIAL_EXIT,
      [0.0, 0.28, -0.08],
    ],
  },

  // —— His ——
  {
    id: "his",
    name: "Penetrating His bundle",
    detail: "AV node → central fibrous body",
    radiusStart: 0.034,
    radiusEnd: 0.028,
    points: [AV, [0.02, -0.04, -0.1], HIS_PEN],
  },
  {
    id: "his",
    name: "Branching His bundle",
    detail: "Membranous septum → bifurcation",
    radiusStart: 0.028,
    radiusEnd: 0.026,
    points: [HIS_PEN, [0.05, -0.18, -0.06], HIS_BRANCH],
  },

  // —— Right bundle ——
  {
    id: "rbb",
    name: "Right bundle branch",
    detail: "Right septal subendocardium",
    radiusStart: 0.022,
    radiusEnd: 0.014,
    tubularSegments: 72,
    points: [
      HIS_BRANCH,
      [-0.02, -0.38, 0.06],
      RBB_MID,
      [-0.12, -0.72, 0.26],
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
      [-0.3, -0.85, 0.42],
      [-0.42, -0.72, 0.5],
      MOD_BAND_END,
    ],
  },

  // —— Left bundle / fascicles ——
  {
    id: "lbb",
    name: "Left bundle (cascade)",
    detail: "Left septal surface under aortic cusp",
    radiusStart: 0.036,
    radiusEnd: 0.028,
    points: [HIS_BRANCH, [0.1, -0.3, -0.02], LBB_ORIGIN],
  },
  {
    id: "lbba",
    name: "Left anterior fascicle",
    detail: "Thin · anterosuperior LV / AL papillary",
    radiusStart: 0.02,
    radiusEnd: 0.01,
    tubularSegments: 56,
    points: [
      LBB_ORIGIN,
      [0.28, -0.32, 0.15],
      [0.42, -0.38, 0.32],
      [0.55, -0.52, 0.4],
      [0.58, -0.72, 0.35],
      [0.5, -0.9, 0.22],
    ],
  },
  {
    id: "lbbp",
    name: "Left posterior fascicle",
    detail: "Broad · inferior / PM papillary",
    radiusStart: 0.026,
    radiusEnd: 0.012,
    tubularSegments: 56,
    points: [
      LBB_ORIGIN,
      [0.26, -0.48, -0.08],
      [0.38, -0.68, -0.1],
      [0.42, -0.9, -0.02],
      [0.35, -1.08, 0.06],
      [0.22, -1.15, 0.08],
    ],
  },
  {
    id: "lbb",
    name: "Left septal fascicle",
    detail: "Mid-septal fibers (variable)",
    radiusStart: 0.016,
    radiusEnd: 0.008,
    tubularSegments: 40,
    points: [
      LBB_ORIGIN,
      [0.12, -0.5, 0.08],
      [0.08, -0.7, 0.12],
      [0.06, -0.92, 0.1],
      [0.05, -1.1, 0.04],
    ],
  },

  // —— RV Purkinje ——
  {
    id: "purkinjeR",
    name: "RV free wall Purkinje · superior",
    detail: "From anterior papillary region",
    radiusStart: 0.012,
    radiusEnd: 0.005,
    tubularSegments: 40,
    points: [
      MOD_BAND_END,
      [-0.58, -0.55, 0.42],
      [-0.62, -0.42, 0.28],
      [-0.55, -0.28, 0.15],
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
      [-0.6, -0.7, 0.38],
      [-0.58, -0.88, 0.25],
      [-0.45, -1.02, 0.12],
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
      [-0.32, -1.05, 0.22],
      [-0.38, -1.12, 0.08],
      [-0.28, -1.15, -0.02],
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
      [-0.08, -1.12, 0.2],
      [0.05, -1.18, 0.08],
      [0.12, -1.12, -0.02],
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
      [-0.05, -0.68, 0.12],
      [0.0, -0.85, 0.08],
      [0.02, -1.0, 0.02],
    ],
  },

  // —— LV Purkinje ——
  {
    id: "purkinjeL",
    name: "LV anterolateral Purkinje",
    detail: "From LAF · free wall",
    radiusStart: 0.012,
    radiusEnd: 0.004,
    tubularSegments: 40,
    points: [
      [0.5, -0.9, 0.22],
      [0.58, -1.0, 0.12],
      [0.48, -1.12, 0.02],
      [0.28, -1.18, -0.02],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV anterolateral Purkinje · base",
    detail: "Toward LVOT / base",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      [0.58, -0.72, 0.35],
      [0.65, -0.58, 0.28],
      [0.62, -0.42, 0.15],
      [0.5, -0.3, 0.05],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV inferior Purkinje",
    detail: "From LPF",
    radiusStart: 0.012,
    radiusEnd: 0.004,
    points: [
      [0.22, -1.15, 0.08],
      [0.08, -1.2, 0.0],
      [-0.05, -1.15, -0.06],
      [-0.12, -1.02, -0.1],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV inferior Purkinje · mid",
    detail: "Posterolateral LV",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      [0.35, -1.08, 0.06],
      [0.48, -1.05, -0.05],
      [0.55, -0.9, -0.12],
      [0.52, -0.72, -0.15],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV septal Purkinje · superior",
    detail: "Left mid-septum",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      [0.06, -0.92, 0.1],
      [0.1, -0.78, 0.05],
      [0.12, -0.62, 0.0],
      [0.1, -0.48, -0.04],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV septal Purkinje · apex",
    detail: "Apical left septum",
    radiusStart: 0.01,
    radiusEnd: 0.004,
    points: [
      [0.05, -1.1, 0.04],
      [0.12, -1.18, -0.02],
      [0.22, -1.2, -0.05],
      [0.32, -1.15, -0.02],
    ],
  },
  {
    id: "purkinjeL",
    name: "LV apical Purkinje fan",
    detail: "Dense apical network",
    radiusStart: 0.009,
    radiusEnd: 0.0035,
    points: [
      [0.28, -1.18, -0.02],
      [0.18, -1.22, 0.05],
      [0.05, -1.2, 0.1],
      [-0.05, -1.15, 0.08],
    ],
  },

  // —— Accessory (WPW) ——
  {
    id: "accessory",
    name: "Kent bundle (left lateral)",
    detail: "Accessory AV connection · mitral annulus",
    radiusStart: 0.018,
    radiusEnd: 0.01,
    points: [
      [0.48, 0.28, 0.12],
      [0.55, 0.12, 0.25],
      [0.58, -0.08, 0.32],
      [0.5, -0.28, 0.28],
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
    const radius = THREE.MathUtils.lerp(radiusStart, radiusEnd, t * t * (3 - 2 * t));

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
  );
  const isFlutter = spec.id === "flutter";
  const isAccessory = spec.id === "accessory";
  const isAvnrt = spec.id === "avnrtSlow" || spec.id === "avnrtFast";
  const color = isFlutter ? 0x7a8a96 : SEGMENT_COLORS[spec.id];
  const mat = new THREE.MeshStandardMaterial({
    color,
    roughness: isFlutter ? 0.55 : 0.35,
    metalness: isFlutter ? 0.05 : 0.08,
    emissive: isFlutter ? 0x3a4550 : color,
    emissiveIntensity: isFlutter || isAvnrt ? 0.08 : 0.12,
    transparent: true,
    opacity: isFlutter ? 0.45 : isAccessory || isAvnrt ? 0.35 : 0.95,
    depthWrite: isFlutter || isAvnrt ? false : true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = spec.name;
  mesh.userData.segmentId = spec.id;
  mesh.userData.segmentName = spec.name;
  mesh.userData.segmentDetail = spec.detail;
  mesh.userData.isConduction = true;
  mesh.userData.baseEmissive = isFlutter || isAvnrt ? 0.08 : 0.12;
  mesh.userData.curve = curve;
  mesh.userData.pathPoints = spec.points;
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
  target.rotation.z = THREE.MathUtils.degToRad(22); // toward patient's left
  target.rotation.x = THREE.MathUtils.degToRad(-38); // tip apex anteriorly
  target.rotation.y = THREE.MathUtils.degToRad(8);
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
  setAccessoryVisible: (visible: boolean) => void;
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
    0.048,
    SEGMENT_COLORS.av,
    "AV node",
    "Triangle of Koch · delay & filter",
    "av",
  );
  const hisBranch = createNode(
    HIS_BRANCH,
    0.03,
    SEGMENT_COLORS.his,
    "His bifurcation",
    "Crest of muscular IV septum",
    "his",
  );

  pathways.add(saMain, saSup, saInf, avNode, hisBranch);
  root.add(pathways);

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
        mat.opacity = id === "accessory" || id === "avnrtSlow" || id === "avnrtFast" ? 0.35 : id === "flutter" ? 0.45 : 1;
        mat.transparent = id === "accessory" || id === "flutter" || id === "avnrtSlow" || id === "avnrtFast";
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
      if (obj.userData.segmentId === "accessory") mat.opacity = 0.35;
      if (obj.userData.segmentId === "flutter") mat.opacity = 0.45;
      if (obj.userData.segmentId === "avnrtSlow" || obj.userData.segmentId === "avnrtFast") {
        mat.opacity = 0.35;
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
      if (obj.userData.hovered) intensity = Math.max(intensity, 1.15);
      mat.emissiveIntensity = intensity;

      if (id === "accessory") {
        mat.opacity = glow > 0 || ekgActive.has(id) ? 0.85 : 0.35;
      }
      if (id === "flutter") {
        mat.opacity = glow > 0 || ekgActive.has(id) ? 0.7 : 0.45;
      }
      if (id === "avnrtSlow" || id === "avnrtFast") {
        mat.opacity = glow > 0 || ekgActive.has(id) ? 0.9 : 0.35;
      }
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
      if (t < b.t0 || t > b.t1) continue;
      if (!ventPhase && isVentricularSeg(b.id)) continue;
      const span = Math.max(1e-4, b.t1 - b.t0);
      const progress = (t - b.t0) / span;
      const uStart = b.u0 ?? (b.reverse ? 1 : 0);
      const uEnd = b.u1 ?? (b.reverse ? 0 : 1);
      const u = uStart + (uEnd - uStart) * progress;
      const curves = curvesBySegment.get(b.id);
      const color = SEGMENT_COLORS[b.id];

      const pushFront = (curveIndex: number) => {
        const pt = pointOnSegment(b.id, u, curveIndex);
        const dir = travelOnSegment(b.id, u, uEnd, curveIndex);
        if (!pt || !dir) return;
        out.push({
          id: b.id,
          pos: [pt.x, pt.y, pt.z],
          dir: [dir.x, dir.y, dir.z],
          color,
          progress,
        });
      };

      if (!curves?.length) {
        if (b.id === "sa" || b.id === "av") pushFront(0);
        continue;
      }
      if (b.curveIndex != null) pushFront(b.curveIndex);
      else {
        for (let ci = 0; ci < curves.length; ci++) pushFront(ci);
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
    pathways.traverse((obj) => {
      if (obj.userData.segmentId === id) obj.visible = visible;
    });
  }

  function setAccessoryVisible(visible: boolean) {
    setSegmentVisibility("accessory", visible);
  }

  resetGlow();
  setAccessoryVisible(false);
  setSegmentVisibility("flutter", false);
  setSegmentVisibility("avnrtSlow", false);
  setSegmentVisibility("avnrtFast", false);

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
    setBlockSite,
    setBranchBlocks,
    updateBlockSitePulse,
    resetGlow,
  };
}
