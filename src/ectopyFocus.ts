import { projectOntoMyocardialShell } from "./heartEllipsoid";
import type { FindingId } from "./findings";
import {
  deviceLeadColor,
  deviceLeadTip,
  deviceLeadTissue,
  deviceLeadsForMode,
  deviceModeForFinding,
  type DeviceLeadId,
} from "./deviceLeads";

/** Myocardial focus for PVC / VT / paced capture (not a conduction tract). */
export type EctopySiteId =
  | "rvFreeWall"
  | "rvot"
  | "rvApex"
  | "lvFreeWall"
  | "lvApex"
  | "lvInfero"
  | "lvLateral"
  | "lvSeptal";

export type EctopySite = {
  id: EctopySiteId;
  label: string;
  short: string;
  /** Heart-local position (mid-myocardial shell) */
  pos: [number, number, number];
  chamber: "rightVent" | "leftVent";
};

/** How often a PVC follows sinus beats in the teaching strip. */
export type PvcPatternId = "bigeminy" | "trigeminy" | "quadrigeminy" | "random";

export type PvcPatternOption = {
  id: PvcPatternId;
  short: string;
  label: string;
};

export const PVC_PATTERNS: PvcPatternOption[] = [
  { id: "bigeminy", short: "Bi", label: "Bigeminy · PVC every other beat" },
  { id: "trigeminy", short: "Tri", label: "Trigeminy · PVC every 3rd beat" },
  { id: "quadrigeminy", short: "Quad", label: "Quadrigeminy · PVC every 4th beat" },
  { id: "random", short: "Rnd", label: "Random · after 1–4 sinus beats" },
];

export type PvcSchedule = {
  cycleSec: number;
  /** Sinus P onsets (seconds) */
  sinusP: number[];
  /** PVC QRS onsets with the sinus QRS they couple from */
  pvcEvents: { q: number; afterSinusQ: number }[];
};

function shell(pos: [number, number, number]): [number, number, number] {
  // Sit mid-wall so the focus marker is flush with the ovoid shell
  return projectOntoMyocardialShell(pos);
}

export const ECTOPY_SITES: EctopySite[] = [
  {
    id: "rvFreeWall",
    label: "RV free wall",
    short: "RV wall",
    pos: shell([-0.52, -0.58, 0.38]),
    chamber: "rightVent",
  },
  { id: "rvot", label: "RVOT", short: "RVOT", pos: shell([-0.22, 0.05, 0.42]), chamber: "rightVent" },
  { id: "rvApex", label: "RV apex", short: "RV apex", pos: shell([-0.28, -0.95, 0.35]), chamber: "rightVent" },
  {
    id: "lvFreeWall",
    label: "LV free wall",
    short: "LV wall",
    pos: shell([0.58, -0.52, 0.18]),
    chamber: "leftVent",
  },
  { id: "lvApex", label: "LV apex", short: "LV apex", pos: shell([0.22, -1.0, 0.05]), chamber: "leftVent" },
  { id: "lvInfero", label: "LV inferobasal", short: "LV inf", pos: shell([0.28, -0.55, -0.28]), chamber: "leftVent" },
  { id: "lvLateral", label: "LV lateral", short: "LV lat", pos: shell([0.55, -0.45, 0.12]), chamber: "leftVent" },
  { id: "lvSeptal", label: "LV septal", short: "LV sep", pos: shell([0.08, -0.55, 0.02]), chamber: "leftVent" },
];

/** Kent ventricular insertion tips (match conductionAnatomy Purkinje–Kent junctions). */
export const KENT_VENT_TIP = {
  left: shell([0.7, -0.41, 0.14]) as [number, number, number],
  right: shell([-0.7, -0.31, 0.22]) as [number, number, number],
};

export function ectopySiteById(id: EctopySiteId): EctopySite {
  return ECTOPY_SITES.find((s) => s.id === id) ?? ECTOPY_SITES[0]!;
}

/** Default focus for a finding (teaching presets). */
export function defaultEctopySite(finding: FindingId): EctopySiteId | null {
  switch (finding) {
    case "pvc":
      return "rvFreeWall";
    case "vt":
    case "vtMonoLbbb":
      return "rvFreeWall";
    case "vtMonoRbbb":
      return "lvFreeWall";
    case "pacedVentricular":
    case "pacedDual":
      return "rvApex";
    case "pacedBiv":
      return "lvLateral";
    case "pacedLbap":
      return "lvSeptal";
    default:
      return null;
  }
}

export function findingUsesEctopyFocus(finding: FindingId): boolean {
  return defaultEctopySite(finding) != null;
}

/** Deterministic 0–1 from integer seed (stable random PVC gaps). */
function hash01(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Build a multi-beat PVC teaching strip with compensatory pauses.
 * `sinusBeforePvc` = how many sinus QRSs precede each PVC (1 = bigeminy).
 */
export function buildPvcSchedule(pattern: PvcPatternId, seed = 1): PvcSchedule {
  const RR = 0.86;
  const pr = 0.16;
  /** Coupling after sinus QRS: mid-diastole (after T), not glued to the T peak. */
  const coupleBase = 0.64;
  const cycleSec = 7.0;
  const sinusP: number[] = [];
  const pvcEvents: { q: number; afterSinusQ: number }[] = [];

  let t = 0.12;
  let beat = 0;
  let sinusInGroup = 0;
  let groupTarget =
    pattern === "bigeminy" ? 1 : pattern === "trigeminy" ? 2 : pattern === "quadrigeminy" ? 3 : 1 + Math.floor(hash01(seed) * 4);

  while (t < cycleSec - 0.55) {
    sinusP.push(t);
    const qSinus = t + pr;
    sinusInGroup += 1;
    beat += 1;

    const coupleJitter = (hash01(seed * 19 + beat) - 0.5) * (pattern === "random" ? 0.18 : 0.1);
    // Occasional early (near T) PVC in random mode for teaching variety
    const early = pattern === "random" && hash01(seed * 41 + beat) < 0.22;
    const couple = early ? 0.4 + hash01(seed + beat) * 0.08 : coupleBase + coupleJitter;

    if (sinusInGroup >= groupTarget && qSinus + couple + 0.35 < cycleSec) {
      const qPvc = qSinus + couple;
      pvcEvents.push({ q: qPvc, afterSinusQ: qSinus });
      // Full compensatory pause relative to the sinus QRS that preceded the PVC
      t = qSinus + 2 * RR - pr;
      sinusInGroup = 0;
      groupTarget =
        pattern === "bigeminy"
          ? 1
          : pattern === "trigeminy"
            ? 2
            : pattern === "quadrigeminy"
              ? 3
              : 1 + Math.floor(hash01(seed * 17 + beat) * 4);
    } else {
      t = qSinus + RR - pr;
    }
  }

  if (sinusP.length === 0) sinusP.push(0.14);
  if (pvcEvents.length === 0) pvcEvents.push({ q: 1.72, afterSinusQ: 1.16 });

  return { cycleSec, sinusP, pvcEvents };
}

export function defaultPvcPattern(): PvcPatternId {
  return "trigeminy";
}

/** Cycle time when myocardial capture starts (spike / PVC onset). */
export function ectopyCaptureT0(finding: FindingId): number {
  switch (finding) {
    case "pacedVentricular":
      return 0.22;
    case "pacedDual":
    case "pacedBiv":
      return 0.28;
    case "pacedLbap":
      return 0.26;
    case "pvc":
      return 0.245;
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
      return 0.08;
    default:
      return 0.2;
  }
}

/** Nearest PVC onset for the current scrub position (multi-beat strip). */
export function ectopyBeatT0(
  finding: FindingId,
  tCycle: number,
  schedule?: PvcSchedule | null,
): number {
  if (finding !== "pvc") return ectopyCaptureT0(finding);
  const beats =
    schedule?.pvcEvents.map((e) => e.q / (schedule.cycleSec || 7)) ??
    buildPvcSchedule(defaultPvcPattern()).pvcEvents.map((e) => e.q / 7);
  const t = ((tCycle % 1) + 1) % 1;
  let best = beats[0]!;
  for (const b of beats) {
    if (t + 0.02 >= b) best = b;
  }
  return best;
}

/** Myocardial shell speed as cycle-fraction per arc unit (smaller = faster). */
export function ectopyFieldSpeed(finding: FindingId, cycleSec = 1): number {
  switch (finding) {
    case "pvc":
      // Absolute ~55 ms/unit so the wave finishes with the wide QRS on the 7 s strip
      return 0.055 / Math.max(0.25, cycleSec);
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
      return 0.34;
    default:
      return 0.42;
  }
}

/** How long the ectopy field wave stays live (cycle fraction). */
export function ectopyWaveDuration(finding: FindingId, cycleSec = 1): number {
  switch (finding) {
    case "pvc":
      // QRS + early discordant T (~0.28 s on the strip)
      return 0.28 / Math.max(0.25, cycleSec);
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
      return 0.55;
    default:
      return 0.45;
  }
}

/** Focus marker fire pulse (cycle fraction). */
export function ectopyFireDuration(finding: FindingId, cycleSec = 1): number {
  switch (finding) {
    case "pvc":
      return 0.12 / Math.max(0.25, cycleSec);
    default:
      return 0.14;
  }
}

/** Wall / pace capture focus for expanding myocardial fields. */
export type CaptureFocus = {
  pos: [number, number, number];
  color: number;
  /** Cycle fraction when the electrode fires */
  t0: number;
  /** Cycle fraction per shell-arc unit */
  speed: number;
  waveDur: number;
  fireDur: number;
  tissue: "atrial" | "ventricular";
  label?: string;
};

/** Spike times (cycle fraction) matching paced EKG waveforms. */
function pacedSpikeT0(finding: FindingId, lead: DeviceLeadId): number | null {
  switch (finding) {
    case "pacedAtrial":
      return lead === "ra" ? 0.08 : null;
    case "pacedVentricular":
      return lead === "rvApex" ? 0.22 : null;
    case "pacedDual":
      if (lead === "ra") return 0.08;
      if (lead === "rvApex") return 0.28;
      return null;
    case "pacedLbap":
      if (lead === "ra") return 0.08;
      if (lead === "lbap") return 0.26;
      return null;
    case "pacedBiv":
      if (lead === "ra") return 0.08;
      if (lead === "rvApex" || lead === "lvCs") return 0.27;
      return null;
    default:
      return null;
  }
}

/**
 * One myocardial capture focus per active pace lead — wall stim first,
 * then pathways engage after the field arrives (PVC-like).
 */
export function pacedCaptureFoci(finding: FindingId): CaptureFocus[] {
  const mode = deviceModeForFinding(finding);
  if (mode === "none") return [];
  const out: CaptureFocus[] = [];
  for (const lead of deviceLeadsForMode(mode)) {
    const t0 = pacedSpikeT0(finding, lead);
    if (t0 == null) continue;
    const tissue = deviceLeadTissue(lead);
    const tip = deviceLeadTip(lead);
    // Sit on the myocardial shell so the field spreads along the wall
    const pos = projectOntoMyocardialShell(tip);
    out.push({
      pos,
      color: deviceLeadColor(lead),
      t0,
      // Atrial shell is smaller; ventricular matches PVC-like cell-to-cell
      speed: tissue === "atrial" ? 0.28 : 0.38,
      waveDur: tissue === "atrial" ? 0.22 : 0.42,
      fireDur: 0.1,
      tissue,
      label: lead,
    });
  }
  return out;
}

/** PVC / VT / paced capture foci for the vector field. */
export function myocardialCaptureFoci(
  finding: FindingId,
  ectopySite: EctopySiteId | null,
): CaptureFocus[] {
  if (finding.startsWith("paced")) return pacedCaptureFoci(finding);
  const siteId = ectopySite ?? defaultEctopySite(finding);
  if (!siteId || !findingUsesEctopyFocus(finding)) return [];
  const site = ectopySiteById(siteId);
  const cycleSec = finding === "pvc" ? 7 : 1;
  return [
    {
      pos: site.pos,
      color: 0xff8844,
      t0: ectopyCaptureT0(finding),
      speed: ectopyFieldSpeed(finding, cycleSec),
      waveDur: ectopyWaveDuration(finding, cycleSec),
      fireDur: ectopyFireDuration(finding, cycleSec),
      tissue: "ventricular",
      label: site.id,
    },
  ];
}
