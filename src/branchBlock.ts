import type { SegmentId } from "./findings";
import { sampleWave, type WaveSample } from "./ekgWaveforms";

/** His–Purkinje branches the user can lesion */
export type BundleBlockId = "rbb" | "lbb" | "lbba" | "lbbp";

export const BUNDLE_BLOCK_OPTIONS: {
  id: BundleBlockId;
  label: string;
  short: string;
}[] = [
  { id: "rbb", label: "Right bundle", short: "RBB" },
  { id: "lbb", label: "Left bundle (main)", short: "LBB" },
  { id: "lbba", label: "Left anterior fascicle", short: "LAF" },
  { id: "lbbp", label: "Left posterior fascicle", short: "LPF" },
];

export type BundleBlockPattern =
  | "nsr"
  | "rbbb"
  | "lbbb"
  | "lafb"
  | "lpfb"
  | "rbbbLafb"
  | "rbbbLpfb"
  | "trifascicular";

/** Effective anterograde lesions (main LBB implies both fascicles) */
export function effectiveBlocks(blocks: Iterable<BundleBlockId>): Set<BundleBlockId> {
  const s = new Set<BundleBlockId>(blocks);
  if (s.has("lbb")) {
    s.add("lbba");
    s.add("lbbp");
  }
  return s;
}

export function classifyBundleBlocks(blocks: Iterable<BundleBlockId>): BundleBlockPattern {
  const e = effectiveBlocks(blocks);
  const r = e.has("rbb");
  const laf = e.has("lbba");
  const lpf = e.has("lbbp");
  const leftComplete = e.has("lbb") || (laf && lpf);

  if (!r && !laf && !lpf) return "nsr";
  if (r && leftComplete) return "trifascicular";
  if (leftComplete) return "lbbb";
  if (r && laf && !lpf) return "rbbbLafb";
  if (r && lpf && !laf) return "rbbbLpfb";
  if (r) return "rbbb";
  if (laf && !lpf) return "lafb";
  if (lpf && !laf) return "lpfb";
  return "nsr";
}

export function describeBundleBlocks(blocks: Iterable<BundleBlockId>): {
  name: string;
  short: string;
  detail: string;
} {
  const pattern = classifyBundleBlocks(blocks);
  const selected = [...new Set(blocks)];
  const parts = selected
    .map((id) => BUNDLE_BLOCK_OPTIONS.find((o) => o.id === id)?.short ?? id)
    .join(" + ");

  switch (pattern) {
    case "nsr":
      return {
        name: "No bundle branch block",
        short: "NSR",
        detail: "Toggle RBB / LBB / LAF / LPF to lesion pathways",
      };
    case "rbbb":
      return {
        name: "Right bundle branch block",
        short: "RBBB",
        detail: `Block in ${parts} · LV first → delayed RV · rsR′ (“M”) V1–V3 · wide slurred S I/aVL/V5–V6`,
      };
    case "lbbb":
      return {
        name: "Left bundle branch block",
        short: "LBBB",
        detail: `Block in ${parts} · RV first → transseptal LV · leftward mean · broad R I/V6 · QS/rS V1`,
      };
    case "lafb":
      return {
        name: "Left anterior fascicular block",
        short: "LAFB",
        detail: `Block in ${parts} · LAD −45°…−90° · qR I/aVL · rS II/III/aVF · R-peak aVL >45 ms`,
      };
    case "lpfb":
      return {
        name: "Left posterior fascicular block",
        short: "LPFB",
        detail: `Block in ${parts} · RAD >+90° · rS I/aVL · qR II/III/aVF · R-peak aVF >45 ms`,
      };
    case "rbbbLafb":
      return {
        name: "Bifascicular block (RBBB + LAFB)",
        short: "RBBB+LAFB",
        detail: `Block in ${parts} · RBBB vectors + left axis · rsR′ V1 · left axis limb leads`,
      };
    case "rbbbLpfb":
      return {
        name: "Bifascicular block (RBBB + LPFB)",
        short: "RBBB+LPFB",
        detail: `Block in ${parts} · RBBB vectors + right axis · rsR′ V1 · right axis limb leads`,
      };
    case "trifascicular":
      return {
        name: "Trifascicular block",
        short: "Tri-fasc",
        detail: `Block in ${parts} · bifascicular + 3° AV block · ventricular escape · AV dissociation`,
      };
  }
}

/** User-selected tracts shown as lesion markers on the model */
export function lesionSegmentsForBlocks(blocks: Iterable<BundleBlockId>): SegmentId[] {
  return [...new Set(blocks)] as SegmentId[];
}

/**
 * Tracts that must not seed the activation map or carry the impulse ball.
 * Expands main LBB → both fascicles, and complete chamber block → distal Purkinje.
 */
export function gatingLesionSegments(blocks: Iterable<BundleBlockId>): SegmentId[] {
  const e = effectiveBlocks(blocks);
  const out: SegmentId[] = [...e];
  if (e.has("rbb")) out.push("purkinjeR");
  if (e.has("lbb") || (e.has("lbba") && e.has("lbbp"))) out.push("purkinjeL");
  return [...new Set(out)];
}

/** Complete left HPS block (LBBB / both fascicles) — RV seeds only, LV via myocardium. */
export function isCompleteLeftBlock(blocks: Iterable<BundleBlockId>): boolean {
  const e = effectiveBlocks(blocks);
  return e.has("lbb") || (e.has("lbba") && e.has("lbbp"));
}

/** Complete right HPS block (RBBB) — LV seeds only, RV via myocardium. */
export function isCompleteRightBlock(blocks: Iterable<BundleBlockId>): boolean {
  return effectiveBlocks(blocks).has("rbb");
}

/** Smooth 0→1 engage window for passive (myocardial) capture of a blocked tract. */
export function passiveBlockEngage(
  tCycle: number,
  blocks: Iterable<BundleBlockId>,
): { left: number; right: number; laf: number; lpf: number } {
  const t = ((tCycle % 1) + 1) % 1;
  const e = effectiveBlocks(blocks);
  const leftComplete = e.has("lbb") || (e.has("lbba") && e.has("lbbp"));
  const rightComplete = e.has("rbb");
  const lafOnly = e.has("lbba") && !e.has("lbbp") && !e.has("lbb");
  const lpfOnly = e.has("lbbp") && !e.has("lbba") && !e.has("lbb");

  const ramp = (t0: number, t1: number) => {
    if (t < t0) return 0;
    if (t > t1) return 1;
    return (t - t0) / Math.max(1e-4, t1 - t0);
  };
  // Fade after ST so tubes return translucent before the next beat
  const hold = (engage: number) => engage * (1 - ramp(0.68, 0.82));

  return {
    // LBBB: right finishes ~0.40, myocardium crosses septum mid–late QRS
    left: leftComplete ? hold(ramp(0.4, 0.56)) : 0,
    // RBBB: left finishes ~0.40, RV fills later
    right: rightComplete ? hold(ramp(0.4, 0.56)) : 0,
    laf: lafOnly || (rightComplete && e.has("lbba") && !leftComplete) ? hold(ramp(0.38, 0.52)) : leftComplete ? hold(ramp(0.4, 0.56)) : 0,
    lpf: lpfOnly || (rightComplete && e.has("lbbp") && !leftComplete) ? hold(ramp(0.38, 0.52)) : leftComplete ? hold(ramp(0.4, 0.56)) : 0,
  };
}

export function blocksForFinding(finding: string | undefined): BundleBlockId[] {
  switch (finding) {
    case "rbbb":
      return ["rbb"];
    case "lbbb":
      return ["lbb"];
    case "lafb":
      return ["lbba"];
    case "lpfb":
      return ["lbbp"];
    case "rbbbLafb":
      return ["rbb", "lbba"];
    case "rbbbLpfb":
      return ["rbb", "lbbp"];
    default:
      return [];
  }
}

export function findingIdForBlocks(blocks: Iterable<BundleBlockId>): import("./findings").FindingId {
  switch (classifyBundleBlocks(blocks)) {
    case "nsr":
      return "nsr";
    case "rbbb":
      return "rbbb";
    case "lbbb":
      return "lbbb";
    case "lafb":
      return "lafb";
    case "lpfb":
      return "lpfb";
    case "rbbbLafb":
      return "rbbbLafb";
    case "rbbbLpfb":
      return "rbbbLpfb";
    case "trifascicular":
      // Stay on a BBB finding id so the CHB expander does not steal the UI.
      // Cycle length / rate use cycleFindingForBlocks → av3.
      return "rbbb";
  }
}

/** Finding whose cycleSec/ventRate should drive the strip when custom lesions are set */
export function cycleFindingForBlocks(
  blocks: Iterable<BundleBlockId>,
): import("./findings").FindingId {
  return classifyBundleBlocks(blocks) === "trifascicular" ? "av3" : findingIdForBlocks(blocks);
}

/** Map custom lesions → matching EKG */
export function sampleFromBundleBlocks(
  blocks: Iterable<BundleBlockId>,
  t: number,
): WaveSample {
  const pattern = classifyBundleBlocks(blocks);
  switch (pattern) {
    case "nsr":
      return sampleWave("nsr", t);
    case "rbbb":
      return sampleWave("rbbb", t);
    case "lbbb":
      return sampleWave("lbbb", t);
    case "lafb":
      return sampleWave("lafb", t);
    case "lpfb":
      return sampleWave("lpfb", t);
    case "rbbbLafb":
      return sampleWave("rbbbLafb", t);
    case "rbbbLpfb":
      return sampleWave("rbbbLpfb", t);
    case "trifascicular":
      return sampleWave("av3", t);
  }
}

export function isBlockableSegment(id: SegmentId): id is BundleBlockId {
  return id === "rbb" || id === "lbb" || id === "lbba" || id === "lbbp";
}
