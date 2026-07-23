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
        detail: `Block in ${parts} · LV first → transseptal RV · rsR′ V1`,
      };
    case "lbbb":
      return {
        name: "Left bundle branch block",
        short: "LBBB",
        detail: `Block in ${parts} · RV first → transseptal LV · broad R I/V6`,
      };
    case "lafb":
      return {
        name: "Left anterior fascicular block",
        short: "LAFB",
        detail: `Block in ${parts} · left axis · qR I/aVL · rS II/III/aVF`,
      };
    case "lpfb":
      return {
        name: "Left posterior fascicular block",
        short: "LPFB",
        detail: `Block in ${parts} · right axis · rS I/aVL · qR inferior`,
      };
    case "rbbbLafb":
      return {
        name: "Bifascicular block (RBBB + LAFB)",
        short: "RBBB+LAFB",
        detail: `Block in ${parts} · RBBB + left axis`,
      };
    case "rbbbLpfb":
      return {
        name: "Bifascicular block (RBBB + LPFB)",
        short: "RBBB+LPFB",
        detail: `Block in ${parts} · RBBB + right axis`,
      };
    case "trifascicular":
      return {
        name: "Trifascicular block",
        short: "Tri-fasc",
        detail: `Block in ${parts} · no His–Purkinje conduction · ventricular escape`,
      };
  }
}

export function lesionSegmentsForBlocks(blocks: Iterable<BundleBlockId>): SegmentId[] {
  return [...new Set(blocks)] as SegmentId[];
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
      return "av3";
  }
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
