import * as THREE from "three";

/**
 * Myocardial vector-field ellipsoid shared by the heart shell, field samples,
 * and ectopy focus placement. Kept free of other app imports to avoid cycles.
 */
export const FIELD_ELLIPSOID = {
  center: new THREE.Vector3(0, -0.15, 0),
  radius: new THREE.Vector3(1.05, 1.15, 0.95),
  outerLimit: 0.95,
  innerLimit: 0.4,
  limit: 0.95,
} as const;

export function ellipsoidNorm2(p: THREE.Vector3 | [number, number, number]): number {
  const x = Array.isArray(p) ? p[0]! : p.x;
  const y = Array.isArray(p) ? p[1]! : p.y;
  const z = Array.isArray(p) ? p[2]! : p.z;
  const { center, radius } = FIELD_ELLIPSOID;
  const nx = x / radius.x;
  const ny = (y - center.y) / radius.y;
  const nz = z / radius.z;
  return nx * nx + ny * ny + nz * nz;
}

export function ellipsoidNormal(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const { center, radius } = FIELD_ELLIPSOID;
  out.set(
    (2 * p.x) / (radius.x * radius.x),
    (2 * (p.y - center.y)) / (radius.y * radius.y),
    (2 * p.z) / (radius.z * radius.z),
  );
  if (out.lengthSq() < 1e-12) out.set(0, 1, 0);
  else out.normalize();
  return out;
}

export function inMyocardialShell(p: THREE.Vector3 | [number, number, number]): boolean {
  const n2 = ellipsoidNorm2(p);
  return n2 >= FIELD_ELLIPSOID.innerLimit && n2 <= FIELD_ELLIPSOID.outerLimit;
}

export function projectOntoShellTangent(dir: THREE.Vector3, pos: THREE.Vector3): THREE.Vector3 {
  const n = ellipsoidNormal(pos);
  const along = dir.dot(n);
  dir.addScaledVector(n, -along);
  if (dir.lengthSq() < 1e-10) {
    const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    dir.crossVectors(n, up);
  }
  return dir.normalize();
}

export function projectOntoMyocardialShell(
  p: THREE.Vector3 | [number, number, number],
  targetNorm2 = (FIELD_ELLIPSOID.innerLimit + FIELD_ELLIPSOID.outerLimit) * 0.55,
): [number, number, number] {
  const { center, radius } = FIELD_ELLIPSOID;
  const x = Array.isArray(p) ? p[0]! : p.x;
  const y = Array.isArray(p) ? p[1]! : p.y;
  const z = Array.isArray(p) ? p[2]! : p.z;
  const ex = x / radius.x;
  const ey = (y - center.y) / radius.y;
  const ez = z / radius.z;
  const n2 = ex * ex + ey * ey + ez * ez;
  if (n2 < 1e-12) {
    return [center.x, center.y - Math.sqrt(targetNorm2) * radius.y * 0.55, center.z];
  }
  const s = Math.sqrt(targetNorm2 / n2);
  return [ex * s * radius.x, center.y + ey * s * radius.y, ez * s * radius.z];
}

const _shellU = new THREE.Vector3();
const _shellV = new THREE.Vector3();

/**
 * Approx geodesic distance along the myocardial shell (not through the cavity).
 * Prevents ectopy wavefronts from "teleporting" across the hollow interior.
 */
export function shellArcDistance(
  a: THREE.Vector3 | [number, number, number],
  b: THREE.Vector3 | [number, number, number],
): number {
  const { center, radius } = FIELD_ELLIPSOID;
  const ax = Array.isArray(a) ? a[0]! : a.x;
  const ay = Array.isArray(a) ? a[1]! : a.y;
  const az = Array.isArray(a) ? a[2]! : a.z;
  const bx = Array.isArray(b) ? b[0]! : b.x;
  const by = Array.isArray(b) ? b[1]! : b.y;
  const bz = Array.isArray(b) ? b[2]! : b.z;
  _shellU.set(ax / radius.x, (ay - center.y) / radius.y, az / radius.z);
  _shellV.set(bx / radius.x, (by - center.y) / radius.y, bz / radius.z);
  if (_shellU.lengthSq() < 1e-12 || _shellV.lengthSq() < 1e-12) return 0;
  _shellU.normalize();
  _shellV.normalize();
  const ang = Math.acos(Math.min(1, Math.max(-1, _shellU.dot(_shellV))));
  const rChar = ((radius.x + radius.y + radius.z) / 3) * Math.sqrt(FIELD_ELLIPSOID.outerLimit);
  return ang * rChar;
}
