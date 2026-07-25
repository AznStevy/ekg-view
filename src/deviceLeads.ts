import * as THREE from "three";

export type DeviceLeadId = "ra" | "rvApex" | "lbap" | "lvCs";

export type DeviceLeadMode = "none" | "aai" | "vvi" | "ddd" | "lbap" | "biv";

export type DeviceLeadsView = {
  root: THREE.Group;
  setMode: (mode: DeviceLeadMode) => void;
  setVisible: (v: boolean) => void;
  getMode: () => DeviceLeadMode;
};

/**
 * Pace-lead geometry in the same patient frame as conductionAnatomy
 * (+X left, +Y superior, +Z anterior). Tip / route anchors track current
 * SA · SVC–RA · CS ostium · RBB apex · LBB origin landmarks.
 *
 * Leads enter through the SVC–RA orifice lumen. SA sits on the lateral rim
 * of that ring — keep routes medial/anterior of SA and clear of internodal tracts.
 */
const SVC_SUP: [number, number, number] = [-0.44, 1.05, 0.08];
/** Orifice lumen biased anterior-medial — same ring as SVC–RA guide, away from SA. */
const SVC_RA_LUMEN: [number, number, number] = [-0.42, 0.66, 0.22];
/** Through tricuspid orifice toward RV (matches TA guide center). */
const TV_ORIFICE: [number, number, number] = [-0.2, -0.02, 0.05];
const CS_OST: [number, number, number] = [-0.06, -0.01, -0.16];

type LeadSpec = {
  label: string;
  /** Full hover title */
  name: string;
  detail: string;
  color: number;
  /** Distal electrode (endocardial / CS tip). */
  tip: [number, number, number];
  /** Catheter course from SVC entry → tip. */
  path: [number, number, number][];
};

const LEADS: Record<DeviceLeadId, LeadSpec> = {
  // RA appendage via SVC–RA junction lumen, then anterior free wall (miss SA / internodals)
  ra: {
    label: "RA",
    name: "RA lead · appendage",
    detail: "Atrial pace/sense · SVC → SVC–RA junction → appendage",
    color: 0xf0c040,
    tip: [-0.36, 0.4, 0.52],
    path: [
      SVC_SUP,
      [-0.45, 0.82, 0.14],
      SVC_RA_LUMEN, // through grey SVC–RA orifice, clear of lateral SA
      // Swing anterior before internodal fan (~[-0.38, 0.52, 0.32])
      [-0.34, 0.54, 0.4],
      [-0.35, 0.45, 0.5],
      [-0.36, 0.4, 0.52],
    ],
  },
  // RV apical endocardium — SVC–RA lumen → RA cavity (miss internodals) → TV → apex
  rvApex: {
    label: "RV",
    name: "RV lead · apex",
    detail: "Ventricular pace/sense · SVC → RA → TV → RV apex",
    color: 0x5ec8ff,
    tip: [-0.28, -1.06, 0.26],
    path: [
      SVC_SUP,
      [-0.45, 0.82, 0.14],
      SVC_RA_LUMEN, // junction lumen, clear of lateral SA
      // RA cavity anterior of middle/anterior internodal fan
      [-0.3, 0.38, 0.18],
      [-0.26, 0.12, 0.14],
      [-0.22, -0.02, 0.1], // TV orifice, slightly anterior
      // RV free-wall side of RBB (RBB_MID ~[-0.08, -0.55, 0.18])
      [-0.3, -0.42, 0.26],
      [-0.3, -0.78, 0.3],
      [-0.28, -1.06, 0.26],
    ],
  },
  // Left-bundle-area / deep septal — at LBB_ORIGIN
  lbap: {
    label: "LBAP",
    name: "LBAP lead · left bundle area",
    detail: "Conduction-system pace · deep septal / LBB capture",
    color: 0x6ae0a8,
    tip: [0.14, -0.34, 0.0],
    path: [
      SVC_SUP,
      [-0.45, 0.82, 0.14],
      SVC_RA_LUMEN,
      [-0.3, 0.38, 0.16],
      [-0.24, 0.1, 0.1],
      TV_ORIFICE,
      [-0.04, -0.22, 0.02],
      [0.05, -0.28, -0.04],
      [0.14, -0.34, 0.0],
    ],
  },
  // CS → posterolateral LV — approach CS from RA cavity, not through AV / Thorel
  lvCs: {
    label: "LV",
    name: "LV lead · CS posterolateral",
    detail: "CRT LV pace · coronary sinus to posterolateral LV",
    color: 0xff7a9a,
    tip: [0.58, -0.48, -0.22],
    path: [
      SVC_SUP,
      [-0.45, 0.82, 0.14],
      SVC_RA_LUMEN,
      // Mid RA cavity — anterior/lateral of internodal → CS
      [-0.3, 0.36, 0.14],
      [-0.22, 0.14, 0.02],
      // Enter CS ostium from RA side (AV / Thorel sit more septal at ~[0, 0.02, -0.12])
      [-0.1, 0.02, -0.14],
      CS_OST,
      [0.12, -0.12, -0.22],
      [0.36, -0.3, -0.26],
      [0.58, -0.48, -0.22],
    ],
  },
};

const MODE_LEADS: Record<DeviceLeadMode, DeviceLeadId[]> = {
  none: [],
  aai: ["ra"],
  vvi: ["rvApex"],
  ddd: ["ra", "rvApex"],
  lbap: ["ra", "lbap"],
  biv: ["ra", "rvApex", "lvCs"],
};

function tagDeviceLeadMesh(mesh: THREE.Mesh, id: DeviceLeadId, spec: LeadSpec): void {
  mesh.userData.isDeviceLead = true;
  mesh.userData.deviceLeadId = id;
  mesh.userData.segmentName = spec.name;
  mesh.userData.segmentDetail = spec.detail;
  mesh.userData.leadLabel = spec.label;
  mesh.userData.leadColor = `#${spec.color.toString(16).padStart(6, "0")}`;
  mesh.userData.baseEmissive = mesh.material instanceof THREE.MeshStandardMaterial
    ? mesh.material.emissiveIntensity
    : 0.15;
}

function makeLead(id: DeviceLeadId): THREE.Group {
  const spec = LEADS[id];
  const g = new THREE.Group();
  g.name = `device-${id}`;
  g.userData.deviceLeadId = id;

  const curve = new THREE.CatmullRomCurve3(
    spec.path.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    false,
    "centripetal",
    0.5,
  );
  const wire = new THREE.Mesh(
    new THREE.TubeGeometry(curve, Math.max(32, spec.path.length * 12), 0.012, 6, false),
    new THREE.MeshStandardMaterial({
      color: 0xc8d0d8,
      metalness: 0.7,
      roughness: 0.25,
      emissive: 0x223038,
      emissiveIntensity: 0.15,
    }),
  );
  wire.name = `device-wire-${id}`;
  tagDeviceLeadMesh(wire, id, spec);
  g.add(wire);

  const tipMat = new THREE.MeshStandardMaterial({
    color: spec.color,
    emissive: spec.color,
    emissiveIntensity: 0.55,
    metalness: 0.45,
    roughness: 0.35,
  });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.048, 14, 12), tipMat);
  tip.position.set(...spec.tip);
  tip.name = `device-tip-${id}`;
  tagDeviceLeadMesh(tip, id, spec);
  g.add(tip);

  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 48;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 48);
  ctx.font = "600 26px Outfit, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e6eaed";
  ctx.fillText(spec.label, 64, 24);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(canvas),
      transparent: true,
      depthTest: false,
      depthWrite: false,
    }),
  );
  sprite.scale.set(0.32, 0.12, 1);
  sprite.position.set(spec.tip[0] + 0.08, spec.tip[1] + 0.1, spec.tip[2] + 0.08);
  g.add(sprite);

  g.visible = false;
  return g;
}

export function createDeviceLeads(): DeviceLeadsView {
  const root = new THREE.Group();
  root.name = "deviceLeads";
  root.visible = false;

  const tips = (Object.keys(LEADS) as DeviceLeadId[]).map((id) => {
    const g = makeLead(id);
    root.add(g);
    return g;
  });

  let mode: DeviceLeadMode = "none";

  function setMode(next: DeviceLeadMode) {
    mode = next;
    const on = new Set(MODE_LEADS[next]);
    for (const g of tips) {
      const id = g.userData.deviceLeadId as DeviceLeadId;
      g.visible = on.has(id);
    }
    root.visible = next !== "none";
  }

  return {
    root,
    setMode,
    setVisible: (v) => {
      root.visible = v && mode !== "none";
    },
    getMode: () => mode,
  };
}

/** Map paced findings → which device leads to show */
export function deviceModeForFinding(finding: string): DeviceLeadMode {
  switch (finding) {
    case "pacedVentricular":
      return "vvi";
    case "pacedDual":
      return "ddd";
    case "pacedLbap":
      return "lbap";
    case "pacedBiv":
      return "biv";
    case "pacedAtrial":
      return "aai";
    default:
      return "none";
  }
}
