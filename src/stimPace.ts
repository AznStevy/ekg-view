import type { SegmentId } from "./findings";
import type { BranchWindow } from "./pathwayTiming";
import {
  sampleStimulated,
  type StimSiteRef,
  type WaveSample,
} from "./ekgWaveforms";

export type StimSite = StimSiteRef;


export type StimState = {
  /** Armed: next click on a pathway sets the pace site */
  armed: boolean;
  site: StimSite | null;
};

export function stimLabel(site: StimSite): string {
  return `Stim · ${site.name}`;
}

export function stimDetail(site: StimSite): string {
  const kind = classifyStim(site.segmentId);
  const map: Record<string, string> = {
    atrial: "Atrial pace → AV → His–Purkinje · narrow QRS",
    junctional: "AV / His pace · no anterograde P · narrow QRS",
    rightVent: "RV / right bundle pace · LBBB-like wide QRS",
    leftVent: "LV / left bundle pace · RBBB-like wide QRS",
    accessory: "Accessory pathway pace · preexcited wide QRS",
    ventricular: "Ventricular myocardium pace · wide QRS",
  };
  return map[kind] ?? "Paced from selected conduction site";
}

export type StimKind = "atrial" | "junctional" | "rightVent" | "leftVent" | "accessory" | "ventricular";

export function classifyStim(id: SegmentId): StimKind {
  switch (id) {
    case "sa":
    case "internodal":
    case "myocardiumA":
    case "flutter":
      return "atrial";
    case "av":
    case "his":
      return "junctional";
    case "rbb":
    case "purkinjeR":
      return "rightVent";
    case "lbb":
    case "lbba":
    case "lbbp":
    case "purkinjeL":
      return "leftVent";
    case "accessory":
      return "accessory";
    default:
      return "ventricular";
  }
}

/** Pathway schedule starting at the paced site */
export function branchesFromStim(site: StimSite): BranchWindow[] {
  const kind = classifyStim(site.segmentId);
  const u = Math.max(0, Math.min(1, site.pathU));
  const ci = site.curveIndex;
  const out: BranchWindow[] = [];

  if (kind === "atrial") {
    out.push({
      id: site.segmentId,
      curveIndex: ci,
      t0: 0.08,
      t1: 0.2,
      group: "atrial",
      u0: u,
      u1: 1,
    });
    if (u > 0.05) {
      out.push({
        id: site.segmentId,
        curveIndex: ci,
        t0: 0.08,
        t1: 0.16,
        group: "atrial",
        u0: u,
        u1: 0,
      });
    }
    out.push(
      { id: "av", t0: 0.18, t1: 0.3, group: "av-delay" },
      { id: "his", t0: 0.3, t1: 0.34, group: "his" },
      { id: "rbb", t0: 0.33, t1: 0.42, group: "bundles" },
      { id: "lbb", t0: 0.33, t1: 0.4, group: "bundles" },
      { id: "lbba", t0: 0.36, t1: 0.45, group: "fascicles" },
      { id: "lbbp", t0: 0.36, t1: 0.46, group: "fascicles" },
      { id: "purkinjeR", t0: 0.4, t1: 0.52, group: "purkinje" },
      { id: "purkinjeL", t0: 0.39, t1: 0.52, group: "purkinje" },
    );
    return out;
  }

  if (kind === "junctional") {
    out.push({ id: site.segmentId, t0: 0.12, t1: 0.28, group: "av-delay" });
    out.push({ id: "his", t0: 0.2, t1: 0.32, group: "his" });
    // Retrograde atrial
    out.push({ id: "internodal", t0: 0.22, t1: 0.36, group: "atrial", reverse: true });
    out.push(
      { id: "rbb", t0: 0.3, t1: 0.42, group: "bundles" },
      { id: "lbb", t0: 0.3, t1: 0.4, group: "bundles" },
      { id: "purkinjeR", t0: 0.38, t1: 0.52, group: "purkinje" },
      { id: "purkinjeL", t0: 0.37, t1: 0.52, group: "purkinje" },
    );
    return out;
  }

  if (kind === "accessory") {
    out.push({
      id: "accessory",
      curveIndex: ci,
      t0: 0.12,
      t1: 0.32,
      group: "accessory",
      u0: u,
      u1: 1,
    });
    out.push(
      { id: "purkinjeL", t0: 0.22, t1: 0.45, group: "purkinje" },
      { id: "lbb", t0: 0.25, t1: 0.4, group: "bundles" },
      { id: "his", t0: 0.28, t1: 0.4, group: "his", reverse: true },
    );
    return out;
  }

  // Ventricular / bundle / Purkinje origin
  out.push({
    id: site.segmentId,
    curveIndex: ci,
    t0: 0.14,
    t1: 0.4,
    group: "ectopy",
    u0: u,
    u1: 1,
  });
  if (u > 0.08) {
    out.push({
      id: site.segmentId,
      curveIndex: ci,
      t0: 0.14,
      t1: 0.32,
      group: "ectopy",
      u0: u,
      u1: 0,
    });
  }

  if (kind === "rightVent") {
    out.push(
      { id: "rbb", t0: 0.2, t1: 0.38, group: "ectopy", reverse: true },
      { id: "purkinjeL", t0: 0.28, t1: 0.55, group: "ectopy" },
      { id: "lbb", t0: 0.3, t1: 0.5, group: "ectopy" },
    );
  } else if (kind === "leftVent") {
    out.push(
      { id: "lbb", t0: 0.2, t1: 0.4, group: "ectopy", reverse: true },
      { id: "purkinjeR", t0: 0.28, t1: 0.55, group: "ectopy" },
      { id: "rbb", t0: 0.3, t1: 0.5, group: "ectopy" },
    );
  } else {
    out.push(
      { id: "purkinjeL", t0: 0.22, t1: 0.5, group: "ectopy" },
      { id: "purkinjeR", t0: 0.24, t1: 0.52, group: "ectopy" },
    );
  }

  return out;
}

export function sampleStim(site: StimSite, t: number): WaveSample {
  return sampleStimulated(site, t);
}
