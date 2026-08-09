import {
  projectOntoMyocardialShell,
  projectOntoSeptum,
  projectOntoVentricularMyocardium,
  inSeptum,
  AV_JUNCTION,
  FIELD_ELLIPSOID,
} from "./heartEllipsoid";
import type { FindingId } from "./findings";
import {
  deviceLeadCapture,
  deviceLeadColor,
  deviceLeadTip,
  deviceLeadTissue,
  deviceLeadsForMode,
  deviceModeForFinding,
  type DeviceLeadId,
} from "./deviceLeads";
import { PULMONARY_VEIN_OSTIA } from "./conductionAnatomy";

/** Myocardial focus for PVC / VT / PAC / paced capture (not a conduction tract). */
export type EctopySiteId =
  | "rvFreeWall"
  | "rvot"
  | "rvApex"
  | "lvFreeWall"
  | "lvApex"
  | "lvInfero"
  | "lvLateral"
  | "lvSeptal"
  | "raHigh"
  | "raLateral"
  | "raLow"
  | "csOstium"
  | "la";

export type EctopySite = {
  id: EctopySiteId;
  label: string;
  short: string;
  /** Heart-local position (mid-myocardial shell) */
  pos: [number, number, number];
  chamber: "rightVent" | "leftVent" | "rightAtrium" | "leftAtrium";
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

/** Ventricular free-wall focus — always below the AV fibrous plane on the new shell lattice. */
function ventShell(pos: [number, number, number]): [number, number, number] {
  let p = projectOntoMyocardialShell(pos);
  if (p[1]! > AV_JUNCTION.planeY - 0.05) {
    p = projectOntoMyocardialShell([p[0]!, AV_JUNCTION.planeY - 0.12, p[2]!]);
  }
  return p;
}

function septal(pos: [number, number, number], face: -1 | 1): [number, number, number] {
  const p = projectOntoSeptum(pos, face);
  // Keep ventricular septal foci on the IVS (below AV plane)
  if (p[1]! > AV_JUNCTION.planeY - 0.02) {
    return projectOntoSeptum([p[0]!, AV_JUNCTION.planeY - 0.1, p[2]!], face);
  }
  return p;
}

export const ECTOPY_SITES: EctopySite[] = [
  {
    id: "rvFreeWall",
    label: "RV free wall",
    short: "RV wall",
    pos: ventShell([-0.52, -0.58, 0.38]),
    chamber: "rightVent",
  },
  // Basal RVOT must stay on the ventricular side of the AV plane (not atrial shell)
  { id: "rvot", label: "RVOT", short: "RVOT", pos: ventShell([-0.28, -0.18, 0.32]), chamber: "rightVent" },
  { id: "rvApex", label: "RV apex", short: "RV apex", pos: ventShell([-0.28, -0.95, 0.35]), chamber: "rightVent" },
  {
    id: "lvFreeWall",
    label: "LV free wall",
    short: "LV wall",
    pos: ventShell([0.58, -0.52, 0.18]),
    chamber: "leftVent",
  },
  { id: "lvApex", label: "LV apex", short: "LV apex", pos: ventShell([0.22, -1.0, 0.05]), chamber: "leftVent" },
  { id: "lvInfero", label: "LV inferobasal", short: "LV inf", pos: ventShell([0.28, -0.55, -0.28]), chamber: "leftVent" },
  { id: "lvLateral", label: "LV lateral", short: "LV lat", pos: ventShell([0.55, -0.45, 0.12]), chamber: "leftVent" },
  { id: "lvSeptal", label: "LV septal", short: "LV sep", pos: septal([0.08, -0.55, 0.02], 1), chamber: "leftVent" },
  // Atrial PAC foci — keep y high enough to stay in the atrial field shell (y ≳ planeY)
  {
    id: "raHigh",
    label: "High RA (near SA)",
    short: "High RA",
    pos: shell([-0.48, 0.82, 0.34]),
    chamber: "rightAtrium",
  },
  {
    id: "raLateral",
    label: "RA free wall",
    short: "RA wall",
    pos: shell([-0.58, 0.38, 0.45]),
    chamber: "rightAtrium",
  },
  {
    id: "raLow",
    label: "Low RA / CTI",
    short: "Low RA",
    pos: shell([-0.42, 0.1, 0.05]),
    chamber: "rightAtrium",
  },
  {
    id: "csOstium",
    label: "CS ostium",
    short: "CS os",
    pos: shell([-0.08, 0.18, -0.2]),
    chamber: "rightAtrium",
  },
  {
    id: "la",
    label: "Left atrium",
    short: "LA",
    pos: shell([0.48, 0.4, -0.18]),
    chamber: "leftAtrium",
  },
];

export const VENTRICULAR_ECTOPY_SITES = ECTOPY_SITES.filter(
  (s) => s.chamber === "rightVent" || s.chamber === "leftVent",
);
export const ATRIAL_ECTOPY_SITES = ECTOPY_SITES.filter(
  (s) => s.chamber === "rightAtrium" || s.chamber === "leftAtrium",
);

export function isAtrialEctopySite(id: EctopySiteId): boolean {
  return ATRIAL_ECTOPY_SITES.some((s) => s.id === id);
}

/** Kent ventricular insertion tips (match conductionAnatomy Purkinje–Kent junctions). */
export const KENT_VENT_TIP = {
  left: ventShell([0.44, -0.62, 0.2]) as [number, number, number],
  right: ventShell([-0.64, -0.34, 0.27]) as [number, number, number],
};

/** Kent atrial insertion tips · mitral/tricuspid AV groove (not superior atrium / Bachmann). */
export const KENT_ATRIAL_INSERT = {
  left: ventShell([0.5, -0.05, 0.1]) as [number, number, number],
  right: ventShell([-0.55, -0.02, 0.16]) as [number, number, number],
};

export function ectopySiteById(id: EctopySiteId): EctopySite {
  return ECTOPY_SITES.find((s) => s.id === id) ?? ECTOPY_SITES[0]!;
}

/** Default focus for a finding (teaching presets). */
export function defaultEctopySite(finding: FindingId): EctopySiteId | null {
  switch (finding) {
    case "pac":
      return "raLow";
    case "pvc":
      return "rvFreeWall";
    case "vt":
    case "vtMonoLbbb":
      return "rvFreeWall";
    case "vtMonoRbbb":
      return "lvFreeWall";
    case "vtPoly":
    case "torsades":
      return "lvApex";
    case "vfCoarse":
    case "vfFine":
      return "lvApex";
    case "av3":
      return "rvApex";
    case "pacedVentricular":
    case "pacedDual":
      return "rvApex";
    case "pacedRvSeptal":
      return "rvot"; // nearest teaching site; capture uses device tip
    case "pacedRvot":
      return "rvot";
    case "pacedHis":
    case "pacedLbap":
      return "lvSeptal";
    case "pacedBiv":
      return "lvLateral";
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
const PVC_SCHEDULE_CACHE = new Map<string, PvcSchedule>();

export function buildPvcSchedule(pattern: PvcPatternId, seed = 1): PvcSchedule {
  const cacheKey = `${pattern}|${seed}`;
  const cached = PVC_SCHEDULE_CACHE.get(cacheKey);
  if (cached) return cached;
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

  const schedule = { cycleSec, sinusP, pvcEvents };
  PVC_SCHEDULE_CACHE.set(cacheKey, schedule);
  return schedule;
}

export function defaultPvcPattern(): PvcPatternId {
  return "trigeminy";
}

/** Cycle time when myocardial capture starts (spike / PVC / PAC onset). */
export function ectopyCaptureT0(finding: FindingId): number {
  switch (finding) {
    case "pacedVentricular":
      return 0.22;
    case "pacedDual":
    case "pacedBiv":
      return 0.28;
    case "pacedRvSeptal":
    case "pacedRvot":
      return 0.27;
    case "pacedHis":
    case "pacedLbap":
      return 0.26;
    case "pvc":
      return 0.245;
    case "pac":
      return 1.72 / 7; // first PAC in the teaching strip
    case "vt":
    case "vtMonoLbbb":
    case "vtMonoRbbb":
      return 0.08;
    default:
      return 0.2;
  }
}

/** PAC P′ onsets in the multi-beat teaching strip (absolute seconds). */
export const PAC_STRIP_EVENTS = [1.72, 3.82] as const;
export const PAC_STRIP_CYCLE_SEC = 7.0;

/** Nearest ectopy onset for the current scrub position (multi-beat strip). */
export function ectopyBeatT0(
  finding: FindingId,
  tCycle: number,
  schedule?: PvcSchedule | null,
): number {
  if (finding === "pac") {
    const beats = PAC_STRIP_EVENTS.map((p) => p / PAC_STRIP_CYCLE_SEC);
    const t = ((tCycle % 1) + 1) % 1;
    let best = beats[0]!;
    for (const b of beats) {
      if (t + 0.02 >= b) best = b;
    }
    return best;
  }
  if (finding === "av3") {
    const beats = [0.5 / 3.33, 2.17 / 3.33];
    const t = ((tCycle % 1) + 1) % 1;
    let best = beats[0]!;
    for (const b of beats) {
      if (t + 0.02 >= b) best = b;
    }
    return best;
  }
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
    case "pac":
      // ~180 ms/unit — visibly expands from the focus before dissipating
      return 0.18 / Math.max(0.25, cycleSec);
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
      // Wide QRS + soft dissipate (~0.7 s absolute)
      return 0.7 / Math.max(0.25, cycleSec);
    case "pac":
      // P′ + atrial activation (~0.35 s)
      return 0.35 / Math.max(0.25, cycleSec);
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
    case "pac":
      return 0.1 / Math.max(0.25, cycleSec);
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
  /** Myocardium vs His/LBAP conduction-tissue capture */
  capture?: "myocardium" | "conduction";
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
    case "pacedRvSeptal":
      if (lead === "ra") return 0.08;
      if (lead === "rvSeptal") return 0.27;
      return null;
    case "pacedRvot":
      if (lead === "ra") return 0.08;
      if (lead === "rvOt") return 0.27;
      return null;
    case "pacedHis":
      if (lead === "ra") return 0.08;
      if (lead === "his") return 0.26;
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
 * One capture focus per active pace lead.
 * Myocardial tips seed the wall first; His/LBAP seed conduction tissue.
 */
export function pacedCaptureFoci(finding: FindingId): CaptureFocus[] {
  const mode = deviceModeForFinding(finding);
  if (mode === "none") return [];
  const out: CaptureFocus[] = [];
  for (const lead of deviceLeadsForMode(mode)) {
    const t0 = pacedSpikeT0(finding, lead);
    if (t0 == null) continue;
    const tissue = deviceLeadTissue(lead);
    const capture = deviceLeadCapture(lead);
    const tip = deviceLeadTip(lead);
    // Conduction tips stay near the lead (His/LBAP); septal myocardium stays on the septum;
    // free-wall myocardium projects to the ovoid shell — ventricular tips stay below AV plane.
    let pos: [number, number, number];
    if (capture === "conduction") {
      pos = tip;
    } else if (lead === "lvCs") {
      // CRT LV tip on endocardial LV free wall (near cavity), not epi shell
      pos = projectOntoMyocardialShell(tip, FIELD_ELLIPSOID.innerLimit * 1.06);
      if (pos[1]! > AV_JUNCTION.planeY - 0.05) {
        pos = projectOntoMyocardialShell(
          [pos[0]!, AV_JUNCTION.planeY - 0.12, pos[2]!],
          FIELD_ELLIPSOID.innerLimit * 1.06,
        );
      }
    } else if (lead === "rvSeptal" || lead === "rvOt" || inSeptum(tip)) {
      pos = projectOntoVentricularMyocardium(tip, lead === "rvSeptal" || lead === "rvOt" ? -1 : undefined);
      if (tissue === "ventricular" && pos[1]! > AV_JUNCTION.planeY - 0.04) {
        pos = ventShell([pos[0]!, AV_JUNCTION.planeY - 0.12, pos[2]!]);
      }
    } else if (tissue === "ventricular") {
      pos = ventShell(tip);
    } else {
      pos = projectOntoMyocardialShell(tip);
    }
    out.push({
      pos,
      color: deviceLeadColor(lead),
      t0,
      // Atrial shell is large — keep wave live long enough to finish (was cutting off mid-atrium)
      speed: capture === "conduction" ? 0.22 : tissue === "atrial" ? 0.24 : 0.38,
      waveDur: capture === "conduction" ? 0.28 : tissue === "atrial" ? 0.48 : 0.42,
      fireDur: 0.1,
      tissue,
      capture,
      label: lead,
    });
  }
  return out;
}

/** PVC / VT / PAC / paced capture foci for the vector field. */
export function myocardialCaptureFoci(
  finding: FindingId,
  ectopySite: EctopySiteId | null,
): CaptureFocus[] {
  if (finding.startsWith("paced")) return pacedCaptureFoci(finding);

  // AFib: one pulmonary-vein ostium drives fibrillatory atria (Haissaguerre).
  // Teaching default = LSPV — pink field must visibly travel across the atria.
  if (finding === "afib") {
    const pv =
      PULMONARY_VEIN_OSTIA.find((p) => p.id === "lspv") ?? PULMONARY_VEIN_OSTIA[2]!;
    return [
      {
        pos: projectOntoMyocardialShell([...pv.pos]),
        color: 0xe040fb,
        t0: 0,
        /** Cycle fraction per shell-arc unit — fast enough to cross LA each burst */
        speed: 0.4,
        waveDur: 0.55,
        fireDur: 0.06,
        tissue: "atrial",
        label: pv.id,
      },
    ];
  }

  const siteId = ectopySite ?? defaultEctopySite(finding);
  if (!siteId || !findingUsesEctopyFocus(finding)) return [];
  const site = ectopySiteById(siteId);
  const atrial = isAtrialEctopySite(siteId);
  const cycleSec = finding === "pvc" || finding === "pac" ? 7 : 1;

  // Polymorphic / VF: several myocardial foci so the field isn't Purkinje-only
  if (finding === "vtPoly" || finding === "torsades" || finding === "vfCoarse" || finding === "vfFine") {
    const ids: EctopySiteId[] =
      finding === "vfFine"
        ? ["lvApex", "rvApex", "lvLateral", "rvFreeWall"]
        : ["lvApex", "rvFreeWall", "lvLateral"];
    return ids.map((id, i) => {
      const s = ectopySiteById(id);
      return {
        pos: s.pos,
        color: 0xff8844,
        t0: 0.08 + i * 0.07,
        speed: finding.startsWith("vf") ? 0.62 : 0.48,
        waveDur: finding.startsWith("vf") ? 0.7 : 0.55,
        fireDur: 0.1,
        tissue: "ventricular" as const,
        label: s.id,
      };
    });
  }

  return [
    {
      pos: site.pos,
      // Magenta atrial focus vs orange ventricular — distinct from SA gold / bundle cyan
      color: atrial ? 0xe040fb : 0xff8844,
      t0: ectopyCaptureT0(finding),
      speed: ectopyFieldSpeed(finding, cycleSec),
      waveDur: ectopyWaveDuration(finding, cycleSec),
      fireDur: ectopyFireDuration(finding, cycleSec),
      tissue: atrial ? "atrial" : "ventricular",
      label: site.id,
    },
  ];
}
