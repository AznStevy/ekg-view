import * as THREE from "three";

export type LeadView = {
  root: THREE.Group;
  setVisible: (v: boolean) => void;
};

type LeadMarker = {
  id: string;
  label: string;
  pos: [number, number, number];
  color: number;
};

/**
 * Patient frame: +X left, +Y superior, +Z anterior.
 * Limb electrodes form Einthoven triangle; V1–V6 wrap the precordium.
 */
const LIMB: LeadMarker[] = [
  { id: "RA", label: "RA", pos: [-1.55, 0.95, 0.35], color: 0xe07070 },
  { id: "LA", label: "LA", pos: [1.55, 0.95, 0.35], color: 0x70c0e0 },
  { id: "LL", label: "LL", pos: [0.15, -1.85, 0.55], color: 0x70e0a0 },
  { id: "RL", label: "RL (Gnd)", pos: [-0.15, -1.85, -0.15], color: 0x8899a8 },
];

const PRECORDIAL: LeadMarker[] = [
  { id: "V1", label: "V1", pos: [-0.15, 0.15, 1.55], color: 0x3db8c8 },
  { id: "V2", label: "V2", pos: [0.2, 0.12, 1.6], color: 0x3db8c8 },
  { id: "V3", label: "V3", pos: [0.55, -0.05, 1.45], color: 0x3db8c8 },
  { id: "V4", label: "V4", pos: [0.95, -0.25, 1.2], color: 0x3db8c8 },
  { id: "V5", label: "V5", pos: [1.25, -0.2, 0.75], color: 0x3db8c8 },
  { id: "V6", label: "V6", pos: [1.4, -0.15, 0.25], color: 0x3db8c8 },
];

function makeLabelSprite(text: string, color: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, 128, 64);
  ctx.font = "600 28px Outfit, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, 64, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.35, 0.175, 1);
  sprite.position.y = 0.12;
  return sprite;
}

function makeElectrode(m: LeadMarker): THREE.Group {
  const g = new THREE.Group();
  g.name = `lead-${m.id}`;
  const mat = new THREE.MeshStandardMaterial({
    color: m.color,
    emissive: m.color,
    emissiveIntensity: 0.35,
    roughness: 0.4,
    metalness: 0.2,
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 12), mat);
  g.add(ball);
  const label = makeLabelSprite(m.label, "#e6eaed");
  g.add(label);
  g.position.set(...m.pos);
  return g;
}

function lineBetween(
  a: THREE.Vector3,
  b: THREE.Vector3,
  color: number,
  opacity = 0.35,
): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  return new THREE.Line(geo, mat);
}

/** Spatial ECG electrode positions + Einthoven triangle */
export function createLeadPositions(): LeadView {
  const root = new THREE.Group();
  root.name = "leadPositions";
  root.visible = false;

  for (const m of [...LIMB, ...PRECORDIAL]) {
    root.add(makeElectrode(m));
  }

  const ra = new THREE.Vector3(...LIMB[0]!.pos);
  const la = new THREE.Vector3(...LIMB[1]!.pos);
  const ll = new THREE.Vector3(...LIMB[2]!.pos);

  // Einthoven triangle
  root.add(lineBetween(ra, la, 0xe07070, 0.4)); // lead I sense
  root.add(lineBetween(ra, ll, 0x70e0a0, 0.4)); // lead II
  root.add(lineBetween(la, ll, 0x70c0e0, 0.35)); // lead III

  // Thin wires from electrodes toward heart center
  const heart = new THREE.Vector3(0, -0.1, 0.1);
  for (const m of PRECORDIAL) {
    root.add(lineBetween(new THREE.Vector3(...m.pos), heart, 0x3db8c8, 0.18));
  }

  // Chest arc hint for V leads
  const arcPts: THREE.Vector3[] = PRECORDIAL.map((m) => new THREE.Vector3(...m.pos));
  const arcGeo = new THREE.BufferGeometry().setFromPoints(arcPts);
  root.add(
    new THREE.Line(
      arcGeo,
      new THREE.LineBasicMaterial({
        color: 0x3db8c8,
        transparent: true,
        opacity: 0.25,
      }),
    ),
  );

  return {
    root,
    setVisible: (v: boolean) => {
      root.visible = v;
    },
  };
}
