import * as THREE from "three";
import type { SegmentId } from "./findings";
import {
  inSeptum,
  myocardialTravelDistance,
  ellipsoidNorm2,
  ellipsoidNormal,
  FIELD_ELLIPSOID,
  SEPTUM_WALL,
  crossesAvJunction,
  clampDirToAvPlane,
  septumCoords,
  septumHalfThicknessAtRho,
} from "./heartEllipsoid";

/** Seed that starts myocardial depolarization (Purkinje exit, pace tip, PVC). */
export type ActivationSeed = {
  pos: [number, number, number] | THREE.Vector3;
  /** Cycle fraction when this seed fires */
  t0: number;
  /** Optional tract that produced the seed (for lesion bookkeeping) */
  segmentId?: SegmentId;
  /** Myocardium vs conduction-tissue capture (His/LBAP engage HPS earlier upstream) */
  capture?: "myocardium" | "conduction";
  /** Display color of this origin — propagated through the LAT wavefront */
  color?: number;
};

export type ActivationSampleInput = {
  pos: THREE.Vector3;
  tissue: "atrial" | "ventricular" | "insulator";
};

export type ActivationSampleState = {
  /** Earliest local activation time (cycle fraction); Infinity if never reached */
  lat: number;
  /** Local action-potential duration (cycle fraction) */
  apd: number;
  /** lat + apd */
  recovery: number;
  /** Unit direction of local depolarization wavefront at LAT (toward later neighbors) */
  depolDir: THREE.Vector3;
  /** Unit direction of recovery wavefront (LAT+APD gradient) */
  repolDir: THREE.Vector3;
  /**
   * Hex color of the activation origin (the seed/focus that first reached this sample).
   * Field arrows use this so color matches the conduction branch that delivered the signal.
   */
  originColor: number;
  /** Conduction segment (or focus) that first activated this sample */
  originSegmentId?: SegmentId;
};

export type ActivationMapResult = {
  samples: ActivationSampleState[];
  /** Earliest ventricular LAT among samples that activated */
  ventLatMin: number;
  /** Latest ventricular LAT */
  ventLatMax: number;
  /** QRS duration in seconds for a given cycle length */
  qrsDurationSec: (cycleSec: number) => number;
  /** QRS width as cycle fraction */
  qrsFrac: number;
};

/** Precomputed k-NN travel graph — build once per sample set. */
export type ActivationGraph = {
  neighbors: number[][];
  dists: number[][];
  sampleCount: number;
};

export type BuildActivationMapOpts = {
  samples: ActivationSampleInput[];
  seeds: ActivationSeed[];
  /**
   * Cycle fraction per unit myocardial travel distance.
   * Smaller = faster spread. Default ~NSR endocardial speed.
   */
  myoSpeed?: number;
  /** Extra multiplier for pure septal hops (already partly in myocardialTravelDistance). */
  septalSpeedScale?: number;
  /** Lesioned tracts — seeds from these IDs are ignored */
  lesionIds?: SegmentId[];
  /**
   * Complete chamber HPS block: slow myocardial hops into / within that half
   * so the field wavefront clearly crosses the septum (LBBB → left, RBBB → right).
   */
  blockedChamber?: "left" | "right" | null;
  /**
   * Isolated fascicular block: slow hops into that LV territory.
   */
  blockedFascicle?: "laf" | "lpf" | null;
  /** Cached k-NN graph (required for interactive frame rates) */
  graph?: ActivationGraph;
};

const INF = 1e9;
const _seedPos = new THREE.Vector3();
const _edge = new THREE.Vector3();
const _depol = new THREE.Vector3();
const _repol = new THREE.Vector3();

function tipDepthNorm(pos: THREE.Vector3): number {
  // Free wall / septum: 0 = endocardial, 1 = epicardial (or mid-septum as deep)
  if (inSeptum(pos)) {
    const { n, rho } = septumCoords(pos);
    const half = septumHalfThicknessAtRho(Math.min(rho, 1));
    if (half < 1e-4) return 0.35;
    // Faces = endocardial (0); midplane = deeper myocardium
    return Math.min(1, 1 - Math.abs(n) / half);
  }
  const n2 = ellipsoidNorm2(pos);
  const { innerLimit, outerLimit } = FIELD_ELLIPSOID;
  return Math.min(1, Math.max(0, (n2 - innerLimit) / Math.max(1e-6, outerLimit - innerLimit)));
}

/** Regional APD (cycle fraction).
 * Ventricular teaching field: nearly uniform APD so recovery order matches
 * depolarization order (first activated → first recovered). ECG T morphology
 * still comes from the lead dipole; the grey field shows the recovery sequence.
 */
export function regionalApd(pos: THREE.Vector3, tissue: ActivationSampleInput["tissue"]): number {
  if (tissue === "insulator") return 0.05;
  if (tissue === "atrial") return 0.14 + (1 - tipDepthNorm(pos)) * 0.03;
  // Small residual transmural / septal jitter — not enough to reverse LAT order
  const base = 0.18;
  const transmural = (1 - tipDepthNorm(pos)) * 0.01;
  const septal = inSeptum(pos) ? 0.006 : 0;
  return base + transmural + septal;
}

/**
 * Teaching fallback: epicardium → endocardium (inward). Prefer recovery-gradient
 * `repolDir` from the activation map when showing sequential recovery.
 */
export function transmuralRepolDir(pos: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  ellipsoidNormal(pos, out);
  out.negate(); // epi (outer) → endo (inner / cavity)
  if (out.lengthSq() < 1e-10) out.set(0, -1, 0);
  else out.normalize();
  return out;
}

/** Endocardium → epicardium (outward through the wall) — depol transmural bias. */
export function transmuralDepolBias(pos: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  ellipsoidNormal(pos, out);
  if (out.lengthSq() < 1e-10) out.set(1, 0, 0);
  else out.normalize();
  return out;
}

/**
 * NSR ventricular depol field — deprecated.
 * Prefer LAT-gradient depolDir from buildActivationMap (structure-agnostic).
 */
export function physiologicVentricularDepolDir(
  _pos: THREE.Vector3,
  out = new THREE.Vector3(),
): THREE.Vector3 {
  return out.copy(SEPTUM_WALL.longAxis);
}

/** @deprecated Prefer LAT depolDir */
export function composeVentricularDepolDir(
  pos: THREE.Vector3,
  _spread: THREE.Vector3,
  out = new THREE.Vector3(),
  _endoEpiWeight = 0.32,
): THREE.Vector3 {
  return physiologicVentricularDepolDir(pos, out);
}

/**
 * Build the myocardial k-NN graph once. O(n²) — never call per frame.
 */
export function buildActivationGraph(
  samples: ActivationSampleInput[],
  _septalSpeedScale = 1.15,
): ActivationGraph {
  const n = samples.length;
  const K = Math.min(18, Math.max(1, n - 1));
  const neighbors: number[][] = Array.from({ length: n }, () => []);
  const dists: number[][] = Array.from({ length: n }, () => []);
  const tmp: { j: number; d: number; cross: boolean }[] = [];

  for (let i = 0; i < n; i++) {
    tmp.length = 0;
    const a = samples[i]!;
    if (a.tissue === "insulator") continue;
    const aSep = inSeptum(a.pos);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const b = samples[j]!;
      if (b.tissue === "insulator") continue;

      // AV fibrous plane: chambers stay separate on the activation graph.
      // (His / Kent timing is handled by pathway seeds — do not flood atria with QRS LAT.)
      if (crossesAvJunction(a.pos, b.pos)) continue;
      if (a.tissue !== b.tissue) continue;

      const bSep = inSeptum(b.pos);
      let d = myocardialTravelDistance(a.pos, b.pos);
      // Shell ↔ septum is one myocardium — slight preference for continuous hops
      if (aSep !== bSep) d *= 0.92;
      else if (aSep && bSep) d *= 0.95;
      tmp.push({ j, d, cross: aSep !== bSep });
    }
    tmp.sort((u, v) => u.d - v.d);

    // Reserve slots for septum↔shell bridges so LAT/dirs cross into blocked chambers
    const chosen = new Set<number>();
    let picked = 0;
    const bridgeBudget = Math.min(7, K);
    for (let k = 0; k < tmp.length && picked < bridgeBudget; k++) {
      const c = tmp[k]!;
      if (!c.cross || c.d > 0.55) continue;
      neighbors[i]!.push(c.j);
      dists[i]!.push(c.d);
      chosen.add(c.j);
      picked++;
    }
    for (let k = 0; k < tmp.length && picked < K; k++) {
      const c = tmp[k]!;
      if (chosen.has(c.j)) continue;
      neighbors[i]!.push(c.j);
      dists[i]!.push(c.d);
      picked++;
    }
  }

  return { neighbors, dists, sampleCount: n };
}

/** Stable fingerprint for map invalidation (finding / lesions / seed schedule). */
export function activationSeedKey(
  seeds: ActivationSeed[],
  lesionIds: SegmentId[] | undefined,
  myoSpeed: number,
  blockedChamber?: "left" | "right" | null,
  blockedFascicle?: "laf" | "lpf" | null,
): string {
  let key = `seq6|${myoSpeed.toFixed(3)}|${blockedChamber ?? ""}|${blockedFascicle ?? ""}|`;
  if (lesionIds?.length) {
    key += lesionIds.slice().sort().join(",") + "|";
  }
  for (const s of seeds) {
    const x = s.pos instanceof THREE.Vector3 ? s.pos.x : s.pos[0]!;
    const y = s.pos instanceof THREE.Vector3 ? s.pos.y : s.pos[1]!;
    const z = s.pos instanceof THREE.Vector3 ? s.pos.z : s.pos[2]!;
    // Quantize so tiny front jitter doesn't thrash Dijkstra
    key += `${s.segmentId ?? ""}:${(s.t0 * 200) | 0}:${(x * 40) | 0},${(y * 40) | 0},${(z * 40) | 0};`;
  }
  return key;
}

function inLafTerritory(p: THREE.Vector3): boolean {
  return p.x > 0.12 && p.z > -0.05 && p.y > -1.08;
}

function inLpfTerritory(p: THREE.Vector3): boolean {
  return p.x > 0.1 && p.z < -0.12 && p.y < -0.35;
}

function inLeftVentTerritory(p: THREE.Vector3): boolean {
  if (inSeptum(p)) {
    const { n } = septumCoords(p);
    return n >= -0.02;
  }
  return p.x >= 0.02;
}

/** RV free wall + right septal face. */
function inRightVentTerritory(p: THREE.Vector3): boolean {
  if (inSeptum(p)) {
    const { n } = septumCoords(p);
    return n < -0.02;
  }
  return p.x < 0.02;
}

/** Extra travel cost when myocardium must fill a blocked HPS territory. */
function blockHopScale(
  a: THREE.Vector3,
  b: THREE.Vector3,
  chamber: "left" | "right" | null | undefined,
  fascicle: "laf" | "lpf" | null | undefined,
): number {
  let s = 1;
  if (chamber === "left") {
    // RV → LV septal cross, then slower LV free-wall fill (no left Purkinje).
    // Keep modest so the teaching field visibly crosses the septum.
    if (a.x < 0.06 && b.x > 0.06) s *= 1.55;
    else if (b.x > 0.08) s *= 1.28;
  } else if (chamber === "right") {
    if (a.x > -0.06 && b.x < -0.06) s *= 1.55;
    else if (b.x < -0.08) s *= 1.28;
  }
  if (fascicle === "laf") {
    const aT = inLafTerritory(a);
    const bT = inLafTerritory(b);
    if (!aT && bT) s *= 1.7;
    else if (bT) s *= 1.25;
  } else if (fascicle === "lpf") {
    const aT = inLpfTerritory(a);
    const bT = inLpfTerritory(b);
    if (!aT && bT) s *= 1.7;
    else if (bT) s *= 1.25;
  }
  return s;
}

/**
 * Build per-sample LAT/APD from discrete seeds + myocardial travel.
 * Pass a prebuilt `graph` — rebuilding neighbors every frame is too expensive.
 */
export function buildActivationMap(opts: BuildActivationMapOpts): ActivationMapResult {
  const myoSpeed = opts.myoSpeed ?? 0.085;
  const septalScale = opts.septalSpeedScale ?? 1.15;
  const lesions = new Set(opts.lesionIds ?? []);
  const blockedChamber = opts.blockedChamber ?? null;
  const blockedFascicle = opts.blockedFascicle ?? null;
  const n = opts.samples.length;

  const states: ActivationSampleState[] = opts.samples.map((s) => ({
    lat: INF,
    apd: regionalApd(s.pos, s.tissue),
    recovery: INF,
    depolDir: new THREE.Vector3(1, 0, 0),
    repolDir: new THREE.Vector3(1, 0, 0),
    originColor: 0x889098,
    originSegmentId: undefined,
  }));

  if (n === 0) {
    return {
      samples: states,
      ventLatMin: 0,
      ventLatMax: 0,
      qrsFrac: 0.12,
      qrsDurationSec: (cycleSec) => Math.max(0.06, cycleSec * 0.12),
    };
  }

  const graph =
    opts.graph && opts.graph.sampleCount === n
      ? opts.graph
      : buildActivationGraph(opts.samples, septalScale);
  const { neighbors, dists } = graph;

  // Seed snap: ventricular HPS / myocardium never lands on atrial samples.
  // Complete BBB: never snap onto the blocked chamber (would light both sides at once).
  const seeds = opts.seeds.filter((s) => !(s.segmentId && lesions.has(s.segmentId)));
  for (const seed of seeds) {
    if (seed.pos instanceof THREE.Vector3) _seedPos.copy(seed.pos);
    else _seedPos.set(seed.pos[0]!, seed.pos[1]!, seed.pos[2]!);
    const wantVent =
      seed.segmentId === "his" ||
      seed.segmentId === "rbb" ||
      seed.segmentId === "lbb" ||
      seed.segmentId === "lbba" ||
      seed.segmentId === "lbbp" ||
      seed.segmentId === "purkinjeL" ||
      seed.segmentId === "purkinjeR" ||
      seed.segmentId === "myocardiumV" ||
      ((seed.capture === "myocardium" || seed.capture === "conduction") &&
        seed.segmentId !== "myocardiumA" &&
        seed.segmentId !== "sa" &&
        seed.segmentId !== "internodal" &&
        seed.segmentId !== "flutter");
    const wantAtrial =
      seed.segmentId === "sa" ||
      seed.segmentId === "internodal" ||
      seed.segmentId === "myocardiumA" ||
      seed.segmentId === "flutter";
    let bestI = -1;
    let bestD = Infinity;
    for (let pass = 0; pass < 2; pass++) {
      bestI = -1;
      bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const s = opts.samples[i]!;
        if (s.tissue === "insulator") continue;
        // Never let atrial pace/PAC seeds paint ventricle (or vice versa) — even on
        // the relaxed pass. Pass 1 only drops chamber/fascicle snap preferences.
        if (wantVent && s.tissue !== "ventricular") continue;
        if (wantAtrial && s.tissue !== "atrial") continue;
        if (pass === 0) {
          if (seed.segmentId === "his" && !inSeptum(s.pos)) continue;
          // Prefer chamber-matched snap for initial seeds (propagation may still cross in BBB)
          if (seed.segmentId === "purkinjeL" || seed.segmentId === "lbb" || seed.segmentId === "lbba" || seed.segmentId === "lbbp") {
            if (inRightVentTerritory(s.pos)) continue;
          }
          if (seed.segmentId === "purkinjeR" || seed.segmentId === "rbb") {
            if (inLeftVentTerritory(s.pos)) continue;
          }
          // Chamber block: free-wall seeds stay on the intact side; His may seed septum
          if (seed.segmentId !== "his") {
            if (blockedChamber === "left" && s.pos.x > -0.1) continue;
            if (blockedChamber === "right" && s.pos.x < 0.1) continue;
          }
          if (blockedFascicle === "laf" && inLafTerritory(s.pos)) continue;
          if (blockedFascicle === "lpf" && inLpfTerritory(s.pos)) continue;
        }
        const d = s.pos.distanceToSquared(_seedPos);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      }
      if (bestI >= 0) break;
    }
    if (bestI < 0) continue;
    const travel = Math.sqrt(bestD) * myoSpeed * 0.35;
    const t = seed.t0 + travel;
    if (t < states[bestI]!.lat) {
      states[bestI]!.lat = t;
      states[bestI]!.originColor = seed.color ?? 0x889098;
      states[bestI]!.originSegmentId = seed.segmentId;
    }
  }

  // Dijkstra with binary-search insert heap
  const inQueue = new Uint8Array(n);
  const heap: number[] = [];
  for (let i = 0; i < n; i++) {
    if (states[i]!.lat < INF) {
      heap.push(i);
      inQueue[i] = 1;
    }
  }
  heap.sort((a, b) => states[a]!.lat - states[b]!.lat);

  while (heap.length) {
    const i = heap.shift()!;
    inQueue[i] = 0;
    const ti = states[i]!.lat;
    const origin = states[i]!.originColor;
    const originSeg = states[i]!.originSegmentId;
    const neigh = neighbors[i]!;
    const nd = dists[i]!;
    const from = opts.samples[i]!.pos;
    const fromHis = originSeg === "his";
    for (let k = 0; k < neigh.length; k++) {
      const j = neigh[k]!;
      const to = opts.samples[j]!.pos;
      // His paints septum (red). In complete BBB, allow myocardial spill from septum
      // into the blocked chamber — but recolor as intact-chamber conduction (not His red).
      let writeColor = origin;
      let writeSeg = originSeg;
      if (fromHis && !inSeptum(to)) {
        const spillLeft = blockedChamber === "left" && to.x > 0.02;
        const spillRight = blockedChamber === "right" && to.x < -0.02;
        if (!spillLeft && !spillRight) continue;
        // LBBB: right (blue) creeps left; RBBB: left (green) creeps right
        writeColor = blockedChamber === "left" ? 0x5ec8ff : 0x6ae0a8;
        writeSeg = blockedChamber === "left" ? "purkinjeR" : "purkinjeL";
      }
      const scale = blockHopScale(from, to, blockedChamber, blockedFascicle);
      const cand = ti + nd[k]! * myoSpeed * scale;
      if (cand + 1e-9 < states[j]!.lat) {
        states[j]!.lat = cand;
        states[j]!.originColor = writeColor;
        states[j]!.originSegmentId = writeSeg;
        if (!inQueue[j]) {
          inQueue[j] = 1;
          let lo = 0;
          let hi = heap.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (states[heap[mid]!]!.lat <= cand) lo = mid + 1;
            else hi = mid;
          }
          heap.splice(lo, 0, j);
        }
      }
    }
  }

  // BBB teaching: blocked free-wall must show intact-chamber color (blue/green),
  // never His red — even if septal His LAT arrived first and spilled.
  if (blockedChamber === "left" || blockedChamber === "right") {
    const spillColor = blockedChamber === "left" ? 0x5ec8ff : 0x6ae0a8;
    const spillSeg: SegmentId = blockedChamber === "left" ? "purkinjeR" : "purkinjeL";
    for (let i = 0; i < n; i++) {
      const s = opts.samples[i]!;
      if (s.tissue !== "ventricular") continue;
      const onBlocked =
        blockedChamber === "left" ? s.pos.x > 0.06 : s.pos.x < -0.06;
      if (!onBlocked) continue;
      // Keep true septum His red; recolor free-wall / outer septum face
      if (inSeptum(s.pos) && Math.abs(s.pos.x) < 0.1) continue;
      const st = states[i]!;
      if (st.lat >= INF) continue;
      if (st.originSegmentId === "his" || st.originColor === 0xff5e6c) {
        st.originColor = spillColor;
        st.originSegmentId = spillSeg;
      }
    }
  }

  // Directions: depol = toward later LAT; repol = toward later recovery (same
  // sequence as depol when APD is nearly uniform).
  for (let i = 0; i < n; i++) {
    const st = states[i]!;
    if (st.lat >= INF) {
      st.recovery = INF;
      continue;
    }
    st.recovery = st.lat + st.apd;
    const pos = opts.samples[i]!.pos;
    _depol.set(0, 0, 0);
    let wDep = 0;
    const neigh = neighbors[i]!;
    for (let ni = 0; ni < neigh.length; ni++) {
      const j = neigh[ni]!;
      const sj = states[j]!;
      if (sj.lat >= INF) continue;
      const other = opts.samples[j]!.pos;
      _edge.set(other.x - pos.x, other.y - pos.y, other.z - pos.z);
      if (_edge.lengthSq() < 1e-10) continue;
      _edge.normalize();
      const dLat = sj.lat - st.lat;
      // Only later tissue — direction of electrical spread
      if (dLat > 1e-5) {
        _depol.addScaledVector(_edge, dLat);
        wDep += dLat;
      }
    }
    if (wDep > 1e-8 && _depol.lengthSq() > 1e-10) {
      st.depolDir.copy(_depol.normalize());
    } else {
      // Terminal site: direction of arrival from earlier neighbors
      _depol.set(0, 0, 0);
      let w = 0;
      for (let ni = 0; ni < neigh.length; ni++) {
        const j = neigh[ni]!;
        const sj = states[j]!;
        if (sj.lat >= INF || sj.lat >= st.lat - 1e-5) continue;
        const other = opts.samples[j]!.pos;
        _edge.set(pos.x - other.x, pos.y - other.y, pos.z - other.z);
        if (_edge.lengthSq() < 1e-10) continue;
        _edge.normalize();
        const wgt = st.lat - sj.lat;
        _depol.addScaledVector(_edge, wgt);
        w += wgt;
      }
      if (w > 1e-8 && _depol.lengthSq() > 1e-10) st.depolDir.copy(_depol.normalize());
      else st.depolDir.copy(SEPTUM_WALL.longAxis);
    }
    // Anterograde map: no field current across the fibrous AV plane (His gap only)
    clampDirToAvPlane(pos, st.depolDir, true);

    // Recovery wavefront: toward neighbors that recover later (same order as depol
    // when APD ≈ constant). Fallback to depolDir if the gradient is flat.
    _repol.set(0, 0, 0);
    let wRep = 0;
    for (let ni = 0; ni < neigh.length; ni++) {
      const j = neigh[ni]!;
      const sj = states[j]!;
      if (sj.recovery >= INF) continue;
      const other = opts.samples[j]!.pos;
      _edge.set(other.x - pos.x, other.y - pos.y, other.z - pos.z);
      if (_edge.lengthSq() < 1e-10) continue;
      _edge.normalize();
      const dRec = sj.recovery - st.recovery;
      if (dRec > 1e-5) {
        _repol.addScaledVector(_edge, dRec);
        wRep += dRec;
      }
    }
    if (wRep > 1e-8 && _repol.lengthSq() > 1e-10) {
      st.repolDir.copy(_repol.normalize());
    } else {
      st.repolDir.copy(st.depolDir);
    }
    clampDirToAvPlane(pos, st.repolDir, true);
  }

  let ventMin = INF;
  let ventMax = -INF;
  for (let i = 0; i < n; i++) {
    if (opts.samples[i]!.tissue !== "ventricular") continue;
    const lat = states[i]!.lat;
    if (lat >= INF) continue;
    ventMin = Math.min(ventMin, lat);
    ventMax = Math.max(ventMax, lat);
  }
  if (ventMin >= INF) {
    ventMin = 0.28;
    ventMax = 0.42;
  }
  const qrsFrac = Math.max(0.06, Math.min(0.55, ventMax - ventMin));

  return {
    samples: states,
    ventLatMin: ventMin,
    ventLatMax: ventMax,
    qrsFrac,
    qrsDurationSec: (cycleSec: number) => Math.max(0.06, Math.min(0.28, qrsFrac * cycleSec)),
  };
}

/** Collect Purkinje / bundle tip seeds from pathway probes near exits. */
export function seedsFromPathwayTips(
  tips: { pos: [number, number, number]; t0: number; segmentId: SegmentId }[],
): ActivationSeed[] {
  return tips.map((t) => ({
    pos: t.pos,
    t0: t.t0,
    segmentId: t.segmentId,
    capture: "conduction" as const,
  }));
}
