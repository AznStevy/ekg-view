import * as THREE from "three";

export type DeviceLeadId = "ra" | "rvApex" | "lbap" | "lvCs";

export type DeviceLeadMode = "none" | "aai" | "vvi" | "ddd" | "lbap" | "biv";

export type DeviceLeadsView = {
  root: THREE.Group;
  setMode: (mode: DeviceLeadMode) => void;
  setVisible: (v: boolean) => void;
  getMode: () => DeviceLeadMode;
};

/** Implantable lead tip positions in patient frame (+X left, +Y up, +Z anterior). */
const TIP: Record<DeviceLeadId, { label: string; pos: [number, number, number]; color: number }> = {
  ra: { label: "RA", pos: [-0.48, 0.52, 0.18], color: 0xf0c040 },
  rvApex: { label: "RV", pos: [-0.18, -0.92, 0.3], color: 0x5ec8ff },
  lbap: { label: "LBAP", pos: [0.12, -0.32, -0.02], color: 0x6ae0a8 },
  lvCs: { label: "LV", pos: [0.72, -0.35, 0.15], color: 0xff7a9a },
};

const MODE_LEADS: Record<DeviceLeadMode, DeviceLeadId[]> = {
  none: [],
  aai: ["ra"],
  vvi: ["rvApex"],
  ddd: ["ra", "rvApex"],
  lbap: ["ra", "lbap"],
  biv: ["ra", "rvApex", "lvCs"],
};

function makeTip(id: DeviceLeadId): THREE.Group {
  const spec = TIP[id];
  const g = new THREE.Group();
  g.name = `device-${id}`;
  g.userData.deviceLeadId = id;

  const mat = new THREE.MeshStandardMaterial({
    color: spec.color,
    emissive: spec.color,
    emissiveIntensity: 0.55,
    metalness: 0.45,
    roughness: 0.35,
  });
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.048, 14, 12), mat);
  g.add(tip);

  // Short lead body stub toward base of heart / generator side
  const stubDir = new THREE.Vector3(-0.35, 0.55, -0.4).normalize();
  const stub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.018, 0.55, 8),
    new THREE.MeshStandardMaterial({
      color: 0xc8d0d8,
      metalness: 0.7,
      roughness: 0.25,
      emissive: 0x223038,
      emissiveIntensity: 0.15,
    }),
  );
  stub.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), stubDir);
  stub.position.copy(stubDir.clone().multiplyScalar(0.28));
  g.add(stub);

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
  sprite.position.set(0.08, 0.1, 0.08);
  g.add(sprite);

  g.position.set(...spec.pos);
  g.visible = false;
  return g;
}

export function createDeviceLeads(): DeviceLeadsView {
  const root = new THREE.Group();
  root.name = "deviceLeads";
  root.visible = false;

  const tips = (Object.keys(TIP) as DeviceLeadId[]).map((id) => {
    const g = makeTip(id);
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
