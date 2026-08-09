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

/**
 * Flat septal wall along the His axis (IAS + IVS).
 * Plane contains AV→His bifurcation; rim hugs the endocardial cavity.
 * Anchors match conductionAnatomy AV / HIS_BRANCH.
 */
const _hisA = new THREE.Vector3(0.0, 0.02, -0.12);
const _hisB = new THREE.Vector3(0.05, -0.28, -0.04);
const _septumLong = new THREE.Vector3().subVectors(_hisB, _hisA).normalize();
const _septumNormal = new THREE.Vector3()
  .crossVectors(new THREE.Vector3(0, 0, 1), _septumLong)
  .normalize();
if (_septumNormal.x < 0) _septumNormal.negate(); // patient-left face
const _septumShort = new THREE.Vector3().crossVectors(_septumNormal, _septumLong).normalize();
const _septumCenter = _hisA
  .clone()
  .addScaledVector(_septumLong, FIELD_ELLIPSOID.center.clone().sub(_hisA).dot(_septumLong));

/** Endocardial cavity (matches heartCavity mesh). */
const CAVITY_NORM2 = FIELD_ELLIPSOID.innerLimit * 0.98 * 0.98;

/**
 * Hourglass septum shape — shared by the visual mesh and activation occupancy.
 * Waist near His; rim flush with endocardial cavity (thickness → 0 at rim).
 */
export const SEPTUM_SHAPE = {
  waistFrac: 0.32,
  filletStart: 0.42,
  /** Half-thickness scale at the pinched waist (× SEPTUM_WALL.thickness/2). */
  coreThickFrac: 0.55,
} as const;

export const SEPTUM_WALL = {
  center: _septumCenter,
  /** Unit normal (≈ patient left) */
  normal: _septumNormal,
  /** Along His / base–apex in the septal plane */
  longAxis: _septumLong,
  /** In-plane AP axis */
  shortAxis: _septumShort,
  /** Full wall thickness (L↔R) at the waist before taper */
  thickness: 0.3,
} as const;

/** @deprecated Prefer SEPTUM_WALL */
export const SEPTUM_OVAL = SEPTUM_WALL;

const _rayD = new THREE.Vector3();
const _septU = new THREE.Vector3();

function sm3(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

function smoothstep5(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function invertSm3(s: number): number {
  const target = Math.min(1, Math.max(0, s));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) * 0.5;
    if (sm3(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** Positive ray hit of origin+t*dir with the endocardial ellipsoid (t>0). */
export function rayHitCavity(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  targetNorm2 = CAVITY_NORM2,
): number | null {
  const { center, radius } = FIELD_ELLIPSOID;
  // Transform into unit-sphere space
  const ox = (origin.x - center.x) / radius.x;
  const oy = (origin.y - center.y) / radius.y;
  const oz = (origin.z - center.z) / radius.z;
  const dx = dir.x / radius.x;
  const dy = dir.y / radius.y;
  const dz = dir.z / radius.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const c = ox * ox + oy * oy + oz * oz - targetNorm2;
  const disc = b * b - 4 * a * c;
  if (disc < 0 || a < 1e-12) return null;
  const s = Math.sqrt(disc);
  const t0 = (-b - s) / (2 * a);
  const t1 = (-b + s) / (2 * a);
  if (t1 > 1e-4) return t1; // outward from interior center
  if (t0 > 1e-4) return t0;
  return null;
}

/** In-plane distance from septal center to endocardial rim (plane ∩ cavity). */
function septumRimDistance(angle: number): number {
  _rayD
    .copy(SEPTUM_WALL.longAxis)
    .multiplyScalar(Math.cos(angle))
    .addScaledVector(SEPTUM_WALL.shortAxis, Math.sin(angle));
  if (_rayD.lengthSq() < 1e-12) return 0.45;
  _rayD.normalize();
  return rayHitCavity(SEPTUM_WALL.center, _rayD, CAVITY_NORM2) ?? 0.45;
}

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

/** Septal-plane coordinates + normalized radial extent (0 at His, 1 at cavity rim). */
export function septumCoords(p: THREE.Vector3 | [number, number, number]): {
  n: number;
  u: number;
  v: number;
  rho: number;
  rim: number;
} {
  const x = Array.isArray(p) ? p[0]! : p.x;
  const y = Array.isArray(p) ? p[1]! : p.y;
  const z = Array.isArray(p) ? p[2]! : p.z;
  const { center, normal, longAxis, shortAxis } = SEPTUM_WALL;
  const dx = x - center.x;
  const dy = y - center.y;
  const dz = z - center.z;
  const n = dx * normal.x + dy * normal.y + dz * normal.z;
  const u = dx * longAxis.x + dy * longAxis.y + dz * longAxis.z;
  const v = dx * shortAxis.x + dy * shortAxis.y + dz * shortAxis.z;
  const rim = septumRimDistance(Math.atan2(v, u));
  const rho = rim > 1e-6 ? Math.hypot(u / rim, v / rim) : 0;
  return { n, u, v, rho, rim };
}

/**
 * Local half-thickness of the hourglass septum at normalized radial rho.
 * Matches buildSeptumWallGeometry (waist pinch + rim taper to zero).
 */
export function septumHalfThicknessAtRho(rho: number): number {
  const half = SEPTUM_WALL.thickness * 0.5;
  const { waistFrac, filletStart, coreThickFrac } = SEPTUM_SHAPE;
  if (rho <= waistFrac) return half * coreThickFrac;
  if (rho >= 1) return 0;
  const s = (rho - waistFrac) / Math.max(1e-4, 1 - waistFrac);
  const rr = invertSm3(s);
  const fillet = smoothstep5((rr - filletStart) / Math.max(1e-4, 1 - filletStart));
  const thickScale = 1 - fillet;
  return half * (coreThickFrac + (1 - coreThickFrac) * sm3(rr)) * thickScale;
}

/** True if point lies in the hourglass septal myocardium (same volume as the mesh). */
export function inSeptum(p: THREE.Vector3 | [number, number, number]): boolean {
  const { n, rho } = septumCoords(p);
  if (rho > 1.02) return false;
  const half = septumHalfThicknessAtRho(Math.min(rho, 1));
  return Math.abs(n) <= half + 1e-3;
}

/**
 * Snap a point onto the hourglass septum.
 * face: -1 = right (patient), 0 = midplane, +1 = left (patient).
 */
export function projectOntoSeptum(
  p: THREE.Vector3 | [number, number, number],
  face: -1 | 0 | 1 = 0,
): [number, number, number] {
  const { center, normal, longAxis, shortAxis } = SEPTUM_WALL;
  let { u, v, rho, rim } = septumCoords(p);
  // Keep slightly inside the rim so thickness stays usable for capture foci.
  const maxRho = 0.92;
  if (rho > maxRho && rho > 1e-8) {
    const s = maxRho / rho;
    u *= s;
    v *= s;
    rho = maxRho;
  } else if (rim < 1e-4) {
    u = 0;
    v = 0;
    rho = 0;
  }
  const half = septumHalfThicknessAtRho(rho);
  const nOff = face === 0 ? 0 : face * half * 0.82;
  _septU
    .copy(center)
    .addScaledVector(longAxis, u)
    .addScaledVector(shortAxis, v)
    .addScaledVector(normal, nOff);
  return [_septU.x, _septU.y, _septU.z];
}

/**
 * Septum = myocardium in the His plane (His runs through the middle; tissue is
 * L/R of His, not a sheet covering it). Hourglass waist near His; rim fillets
 * onto the endocardial cavity so contact with the shell is smooth.
 */
export function buildSeptumWallGeometry(segments = 96, rings = 28, filletSegs = 10): THREE.BufferGeometry {
  const { center: sepC, normal, longAxis, shortAxis, thickness } = SEPTUM_WALL;
  const { waistFrac, filletStart, coreThickFrac } = SEPTUM_SHAPE;
  const half = thickness * 0.5;
  const fieldC = FIELD_ELLIPSOID.center;
  const { radius } = FIELD_ELLIPSOID;

  const positions: number[] = [];
  const normalsArr: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const rim = new THREE.Vector3();
  const shellN = new THREE.Vector3();
  const waist = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const faceN = new THREE.Vector3();

  const pushV = (v: THREE.Vector3, n: THREE.Vector3) => {
    positions.push(v.x, v.y, v.z);
    normalsArr.push(n.x, n.y, n.z);
  };

  /** Project onto the endocardial cavity surface (never into the myocardial wall). */
  const projectToCavity = (v: THREE.Vector3, out: THREE.Vector3) => {
    const fdx = (v.x - fieldC.x) / radius.x;
    const fdy = (v.y - fieldC.y) / radius.y;
    const fdz = (v.z - fieldC.z) / radius.z;
    const fn2 = fdx * fdx + fdy * fdy + fdz * fdz;
    const fs = Math.sqrt(CAVITY_NORM2 / Math.max(fn2, 1e-12));
    out.set(
      fieldC.x + fdx * fs * radius.x,
      fieldC.y + fdy * fs * radius.y,
      fieldC.z + fdz * fs * radius.z,
    );
    return out;
  };

  /** Plane ∩ endocardial cavity along an in-plane direction from the septal center. */
  const rimInPlane = (d: THREE.Vector3, out: THREE.Vector3) => {
    const t = rayHitCavity(sepC, d, CAVITY_NORM2);
    if (t == null || t < 1e-4) {
      out.copy(sepC).addScaledVector(d, 0.4);
      return out;
    }
    out.copy(sepC).addScaledVector(d, t);
    return out;
  };

  const rims: THREE.Vector3[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    dir
      .copy(longAxis)
      .multiplyScalar(Math.cos(a))
      .addScaledVector(shortAxis, Math.sin(a))
      .normalize();
    rims.push(rimInPlane(dir, new THREE.Vector3()));
  }

  // In-plane pinch near His; soft fillet onto the cavity at the rim (stays on endo).
  const faceOuter: [number, number] = [0, 0];

  for (let side = 0; side < 2; side++) {
    const sign = side === 0 ? -1 : 1;

    const centerIdx = positions.length / 3;
    p.copy(sepC).addScaledVector(normal, sign * half * coreThickFrac);
    nrm.copy(normal).multiplyScalar(sign);
    pushV(p, nrm);

    const ringBase = positions.length / 3;

    for (let r = 0; r < rings; r++) {
      const rr = (r + 1) / rings;
      const radial = waistFrac + (1 - waistFrac) * sm3(rr);
      const fillet = smoothstep5((rr - filletStart) / Math.max(1e-4, 1 - filletStart));
      // Thickness eases to zero at the rim so faces meet the cavity without a lip into the wall.
      const thickScale = 1 - fillet;
      const offset = half * (coreThickFrac + (1 - coreThickFrac) * sm3(rr)) * thickScale;

      for (let i = 0; i < segments; i++) {
        rim.copy(rims[i]!);
        waist.copy(sepC).lerp(rim, radial);
        p.copy(waist).addScaledVector(normal, sign * offset);

        if (fillet > 0) {
          // Foot stays on plane∩cavity — no push into the myocardial shell.
          projectToCavity(rim, tmp);
          p.lerpVectors(p, tmp, fillet);
        }

        nrm.copy(normal).multiplyScalar(sign);
        if (fillet > 0) {
          ellipsoidNormal(p, shellN);
          shellN.negate(); // inward (cavity) normal
          nrm.lerp(shellN, fillet);
          if (nrm.lengthSq() > 1e-10) nrm.normalize();
        }
        pushV(p, nrm);
      }
    }

    faceOuter[side] = ringBase + (rings - 1) * segments;

    for (let i = 0; i < segments; i++) {
      const i0 = ringBase + i;
      const i1 = ringBase + ((i + 1) % segments);
      if (side === 0) indices.push(centerIdx, i0, i1);
      else indices.push(centerIdx, i1, i0);
    }

    for (let r = 0; r < rings - 1; r++) {
      for (let i = 0; i < segments; i++) {
        const i0 = ringBase + r * segments + i;
        const i1 = ringBase + r * segments + ((i + 1) % segments);
        const i2 = ringBase + (r + 1) * segments + i;
        const i3 = ringBase + (r + 1) * segments + ((i + 1) % segments);
        if (side === 0) {
          indices.push(i0, i2, i1, i1, i2, i3);
        } else {
          indices.push(i0, i1, i2, i1, i3, i2);
        }
      }
    }
  }

  // Rounded rim strip on the cavity surface (lumen side) — does not enter the shell wall.
  const rimBase = positions.length / 3;
  const filletRadius = half * 0.45;

  for (let k = 0; k <= filletSegs; k++) {
    const tk = k / filletSegs;
    const ang = Math.PI * (tk - 0.5); // −π/2 → +π/2
    const sinA = Math.sin(ang);

    for (let i = 0; i < segments; i++) {
      rim.copy(rims[i]!);
      ellipsoidNormal(rim, shellN);

      bitangent.copy(normal).addScaledVector(shellN, -normal.dot(shellN));
      if (bitangent.lengthSq() > 1e-10) bitangent.normalize();
      else bitangent.copy(normal);

      // Arc L↔R in the septal frame, then clamp back onto the endocardial surface.
      p.copy(rim).addScaledVector(bitangent, sinA * filletRadius);
      // Slight lumen-side roundness (toward cavity center), not into myocardium.
      p.addScaledVector(shellN, -filletRadius * 0.2 * (1 - Math.abs(sinA)));
      projectToCavity(p, p);

      ellipsoidNormal(p, nrm);
      nrm.negate();
      faceN.copy(normal).multiplyScalar(sinA < 0 ? -1 : 1);
      nrm.lerp(faceN, Math.pow(Math.abs(sinA), 1.6) * 0.35);
      if (nrm.lengthSq() > 1e-10) nrm.normalize();
      pushV(p, nrm);
    }
  }

  // Stitch fillet strip to each face's outer ring, then fill strip quads.
  const leftOuter = faceOuter[0]!;
  const rightOuter = faceOuter[1]!;
  for (let i = 0; i < segments; i++) {
    const i0 = leftOuter + i;
    const i1 = leftOuter + ((i + 1) % segments);
    const j0 = rimBase + i;
    const j1 = rimBase + ((i + 1) % segments);
    indices.push(i0, j0, i1, i1, j0, j1);

    const k0 = rimBase + filletSegs * segments + i;
    const k1 = rimBase + filletSegs * segments + ((i + 1) % segments);
    const r0 = rightOuter + i;
    const r1 = rightOuter + ((i + 1) % segments);
    indices.push(r0, r1, k0, r1, k1, k0);
  }

  for (let k = 0; k < filletSegs; k++) {
    for (let i = 0; i < segments; i++) {
      const i0 = rimBase + k * segments + i;
      const i1 = rimBase + k * segments + ((i + 1) % segments);
      const i2 = rimBase + (k + 1) * segments + i;
      const i3 = rimBase + (k + 1) * segments + ((i + 1) % segments);
      indices.push(i0, i2, i1, i1, i2, i3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(normalsArr, 3));
  geo.setIndex(indices);
  // Keep authored contact normals (computeVertexNormals would sharpen the shell join).
  geo.computeBoundingSphere();
  return geo;
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

/**
 * Myocardial wall OR septum — samples that participate in ventricular activation.
 * Septal core is inside the cavity ellipsoid but still conductive myocardium.
 */
export function inVentricularMyocardium(p: THREE.Vector3 | [number, number, number]): boolean {
  return inMyocardialShell(p) || inSeptum(p);
}

export function projectOntoShellTangent(dir: THREE.Vector3, pos: THREE.Vector3): THREE.Vector3 {
  // Inside the septum, allow through-thickness travel (do not flatten to shell)
  if (inSeptum(pos)) {
    if (dir.lengthSq() < 1e-10) dir.set(1, 0, 0);
    else dir.normalize();
    return dir;
  }
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

/**
 * Project onto septal myocardium when the point belongs in the cavity septum;
 * otherwise onto the free-wall mid-shell.
 */
export function projectOntoVentricularMyocardium(
  p: THREE.Vector3 | [number, number, number],
  face?: -1 | 0 | 1,
): [number, number, number] {
  const x = Array.isArray(p) ? p[0]! : p.x;
  const y = Array.isArray(p) ? p[1]! : p.y;
  const z = Array.isArray(p) ? p[2]! : p.z;
  const n2 = ellipsoidNorm2([x, y, z]);
  const { n } = septumCoords([x, y, z]);
  const preferFace: -1 | 0 | 1 =
    face ?? (Math.abs(n) < 1e-6 ? 0 : n > 0 ? 1 : -1);
  const septal = projectOntoSeptum([x, y, z], preferFace === 0 ? (n >= 0 ? 1 : -1) : preferFace);
  // Inside / near cavity, or already septal → keep on septum
  if (n2 < FIELD_ELLIPSOID.innerLimit * 1.12 || inSeptum([x, y, z]) || inSeptum(septal)) {
    return septal;
  }
  return projectOntoMyocardialShell([x, y, z]);
}

const _shellU = new THREE.Vector3();
const _shellV = new THREE.Vector3();

/** AV fibrous plane + His penetration (field insulator / only anterograde bridge). */
export const AV_JUNCTION = {
  planeY: 0.04,
  center: new THREE.Vector3(0.02, 0.04, -0.05),
  hisGap: new THREE.Vector3(0.04, 0.02, -0.08),
  hisGapR: 0.11,
} as const;

export function nearHisPenetration(
  p: THREE.Vector3 | [number, number, number],
  r: number = AV_JUNCTION.hisGapR,
): boolean {
  const x = Array.isArray(p) ? p[0]! : p.x;
  const y = Array.isArray(p) ? p[1]! : p.y;
  const z = Array.isArray(p) ? p[2]! : p.z;
  const g = AV_JUNCTION.hisGap;
  const dx = x - g.x;
  const dy = y - g.y;
  const dz = z - g.z;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** True if segment ab crosses the AV plane away from the His gap. */
export function crossesAvJunction(
  a: THREE.Vector3 | [number, number, number],
  b: THREE.Vector3 | [number, number, number],
): boolean {
  const ay = Array.isArray(a) ? a[1]! : a.y;
  const by = Array.isArray(b) ? b[1]! : b.y;
  const py = AV_JUNCTION.planeY;
  if ((ay - py) * (by - py) >= 0) return false;
  if (nearHisPenetration(a) && nearHisPenetration(b)) return false;
  return true;
}

/**
 * Approx geodesic distance along the free-wall shell (no septum penalty).
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

/**
 * Travel cost for activation: shell ∪ septum is one continuous ventricular myocardium.
 * AV fibrous plane is blocking except at the His penetration.
 */
export function myocardialTravelDistance(
  a: THREE.Vector3 | [number, number, number],
  b: THREE.Vector3 | [number, number, number],
): number {
  const ax = Array.isArray(a) ? a[0]! : a.x;
  const ay = Array.isArray(a) ? a[1]! : a.y;
  const az = Array.isArray(a) ? a[2]! : a.z;
  const bx = Array.isArray(b) ? b[0]! : b.x;
  const by = Array.isArray(b) ? b[1]! : b.y;
  const bz = Array.isArray(b) ? b[2]! : b.z;
  const eucl = Math.hypot(bx - ax, by - ay, bz - az);

  if (crossesAvJunction(a, b)) {
    // Only His gap conducts across the AV plane
    if (nearHisPenetration(a) && nearHisPenetration(b)) return eucl * 1.2;
    return eucl * 8; // fibrous insulator — effectively blocked for k-NN
  }

  const aSep = inSeptum(a);
  const bSep = inSeptum(b);
  const aShell = inMyocardialShell(a);
  const bShell = inMyocardialShell(b);

  // Ventricular continuum: septum and shell share Euclidean hops at the junction
  if ((aSep || aShell) && (bSep || bShell)) {
    if (aSep || bSep) return eucl * 1.02;
    // Pure free-wall: prefer shell geodesic so paths hug the wall
    return Math.min(eucl * 1.2, shellArcDistance(a, b));
  }

  // Atrial (or mixed non-vent) — shell arc
  return shellArcDistance(a, b);
}

/**
 * Strip direction components that would carry anterograde current across the AV plane.
 * His penetration may only cross atrium → ventricle (inferior), never up into the atria.
 * Free-wall ventricle aiming *at* the plane keeps its trajectory — callers shorten
 * arrows at the fibrous plane instead of forcing the field downward/flat.
 */
export function clampDirToAvPlane(
  pos: THREE.Vector3,
  dir: THREE.Vector3,
  anterograde = true,
): THREE.Vector3 {
  if (!anterograde || dir.lengthSq() < 1e-10) return dir;

  const py = AV_JUNCTION.planeY;
  if (Math.abs(dir.y) <= 1e-8) return dir;

  const t = (py - pos.y) / dir.y;
  if (t > 0.02 && t < 0.55) {
    const hitX = pos.x + dir.x * t;
    const hitZ = pos.z + dir.z * t;
    const inGap = nearHisPenetration([hitX, py, hitZ], AV_JUNCTION.hisGapR * 1.15);
    // Only atrium → ventricle through the His gap is allowed
    const atriumToVent = pos.y > py && dir.y < 0;
    // Ventricular free wall approaching the insulator: keep LAT direction
    const ventTowardPlane =
      pos.y < py - 0.005 &&
      dir.y > 0 &&
      !nearHisPenetration(pos, AV_JUNCTION.hisGapR * 2.0);
    if (ventTowardPlane) {
      /* keep dir — length clipping stops the arrow on the plane */
    } else if (!(atriumToVent && inGap)) {
      dir.y = 0;
      if (dir.lengthSq() < 1e-10) {
        dir.set(0, pos.y < py ? -1 : 1, 0);
      } else dir.normalize();
    }
  }

  // Below the plane near the AV node: never aim superiorly past the fibrous ring
  if (pos.y <= py + 0.02 && dir.y > 0.08 && nearHisPenetration(pos, AV_JUNCTION.hisGapR * 2.2)) {
    dir.y = Math.min(0, dir.y);
    if (dir.lengthSq() < 1e-10) dir.set(0, -1, 0);
    else dir.normalize();
  }

  return dir;
}
