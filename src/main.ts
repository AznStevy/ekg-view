import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createActivationVectors } from "./activationVectors";
import {
  createConductionSystem,
  applyAnatomicOrientation,
  SEGMENT_META,
  type ConductionSystem,
} from "./conductionAnatomy";
import { createEkgTrace } from "./ekgTrace";
import { createLeadPositions } from "./leadPositions";
import {
  layoutLabel,
  parseEkgFile,
  reprocessUploadFromRegions,
  exportUploadedCsv,
  exportUploadedAecgXml,
  type UploadedEkg,
} from "./ekgUpload";
import { createSplitEditor } from "./uploadSplitEditor";
import {
  curatedDbMatches,
  loadPhysioNetRecord,
  searchCuratedRecords,
  searchPhysioNetProjects,
  type PhysioRecordRef,
} from "./physionet";
import {
  FINDINGS,
  cycleSecForRate,
  findingMatchesQuery,
  getFinding,
  isAvnrtFinding,
  isAvrtFinding,
  isAvrtAntiFinding,
  avrtKentSide,
  type FindingId,
  type SegmentId,
} from "./findings";
import {
  branchesFromStim,
  sampleStim,
  stimDetail,
  stimLabel,
  stimSegmentForGuide,
  type StimSite,
  type StimState,
} from "./stimPace";
import { createDeviceLeads, deviceModeForFinding, PACED_BASE_MODES, isPacingFailureFinding, type DeviceLeadMode } from "./deviceLeads";
import { blockSiteForFinding, branchesFromBundleBlocks, branchesForPvcSite } from "./pathwayTiming";
import {
  BUNDLE_BLOCK_OPTIONS,
  blocksForFinding,
  describeBundleBlocks,
  findingIdForBlocks,
  isBlockableSegment,
  gatingLesionSegments,
  lesionSegmentsForBlocks,
  passiveBlockEngage,
  sampleFromBundleBlocks,
  type BundleBlockId,
} from "./branchBlock";
import {
  ATRIAL_ECTOPY_SITES,
  KENT_VENT_TIP,
  PAC_STRIP_CYCLE_SEC,
  PVC_PATTERNS,
  VENTRICULAR_ECTOPY_SITES,
  buildPvcSchedule,
  defaultEctopySite,
  defaultPvcPattern,
  ectopyBeatT0,
  ectopySiteById,
  myocardialCaptureFoci,
  type EctopySiteId,
  type PvcPatternId,
  type PvcSchedule,
} from "./ectopyFocus";
import {
  cardioversionDurationSec,
  cardioversionWallTCycle,
  sampleCardioversionAt,
  samplePacPattern,
  samplePvcPattern,
  setMapQrsTiming,
} from "./ekgWaveforms";

const BBB_FINDING_IDS = new Set<FindingId>([
  "rbbb",
  "lbbb",
  "lafb",
  "lpfb",
  "rbbbLafb",
  "rbbbLpfb",
]);

const CHB_FINDING_IDS = new Set<FindingId>(["av3Junctional", "av3"]);

const CHB_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "av3Junctional",
    short: "Junctional",
    name: "Narrow escape · supra-His",
  },
  {
    id: "av3",
    short: "Ventricular",
    name: "Wide escape · infra-His",
  },
];

const FLUTTER_FINDING_IDS = new Set<FindingId>(["aflutterCcw", "aflutterCw"]);

const FLUTTER_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "aflutterCcw",
    short: "CCW",
    name: "Typical · inferior − sawtooth",
  },
  {
    id: "aflutterCw",
    short: "CW",
    name: "Reverse typical · inferior + F",
  },
];

const VF_FINDING_IDS = new Set<FindingId>(["vfCoarse", "vfFine"]);

const VF_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "vfCoarse",
    short: "Coarse",
    name: "Larger chaotic undulations",
  },
  {
    id: "vfFine",
    short: "Fine",
    name: "Low-amplitude chaos",
  },
];

const VT_FINDING_IDS = new Set<FindingId>(["vt", "vtMonoLbbb", "vtMonoRbbb", "vtPoly", "torsades"]);

const VT_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "vt",
    short: "Mono",
    name: "Monomorphic · identical wide QRS",
  },
  {
    id: "vtMonoLbbb",
    short: "LBBB",
    name: "LBBB morphology · often RV/outflow",
  },
  {
    id: "vtMonoRbbb",
    short: "RBBB",
    name: "RBBB morphology · often LV origin",
  },
  {
    id: "vtPoly",
    short: "Poly",
    name: "Polymorphic · changing QRS / axis",
  },
  {
    id: "torsades",
    short: "TdP",
    name: "Torsades · long QT · twists around baseline",
  },
];

const PACED_FINDING_IDS = new Set<FindingId>([
  "pacedAtrial",
  "pacedVentricular",
  "pacedDual",
  "pacedRvSeptal",
  "pacedRvot",
  "pacedHis",
  "pacedLbap",
  "pacedBiv",
  "failureToPace",
  "failureToCapture",
  "failureToSense",
]);

const PACED_MODE_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "pacedAtrial",
    short: "AAI",
    name: "Atrial paced · spike → P → QRS",
  },
  {
    id: "pacedVentricular",
    short: "VVI",
    name: "RV apical · spike → wide QRS",
  },
  {
    id: "pacedDual",
    short: "DDD",
    name: "Dual chamber · A then V spikes",
  },
  {
    id: "pacedRvSeptal",
    short: "RVs",
    name: "RV septal · myocardial capture",
  },
  {
    id: "pacedRvot",
    short: "RVOT",
    name: "RVOT · inferior-axis paced QRS",
  },
  {
    id: "pacedHis",
    short: "His",
    name: "His-bundle · near-physiologic QRS",
  },
  {
    id: "pacedLbap",
    short: "LBAP",
    name: "Left bundle area · narrower QRS",
  },
  {
    id: "pacedBiv",
    short: "BiV",
    name: "CRT · RA + RV + LV capture",
  },
];

const PACED_FAIL_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "failureToPace",
    short: "No pace",
    name: "Output failure · no spike",
  },
  {
    id: "failureToCapture",
    short: "No capt.",
    name: "Spike present · no capture",
  },
  {
    id: "failureToSense",
    short: "Undersense",
    name: "Ignores intrinsic · competing spikes",
  },
];

const STEMI_FINDING_IDS = new Set<FindingId>([
  "stemiAnt",
  "stemiInferior",
  "stemiLateral",
  "stemiAnterolateral",
  "stemiPosterior",
  "stemiAvr",
  "dewinter",
  "wellens",
  "sgarbossa",
]);

const STEMI_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "stemiAnt",
    short: "Anterior",
    name: "STE V1–V4 · LAD",
  },
  {
    id: "stemiInferior",
    short: "Inferior",
    name: "STE II · III · aVF",
  },
  {
    id: "stemiLateral",
    short: "Lateral",
    name: "STE I · aVL · V5–V6",
  },
  {
    id: "stemiAnterolateral",
    short: "Ant-lat",
    name: "Extensive V2–V6 · I · aVL",
  },
  {
    id: "stemiPosterior",
    short: "Posterior",
    name: "Tall R + horizontal STD V1–V3",
  },
  {
    id: "stemiAvr",
    short: "aVR STE",
    name: "aVR STE · diffuse STD · LMCA cue",
  },
  {
    id: "dewinter",
    short: "De Winter",
    name: "Upsloping STD + hyperacute T",
  },
  {
    id: "wellens",
    short: "Wellens",
    name: "Biphasic / deep T V2–V3",
  },
  {
    id: "sgarbossa",
    short: "Sgarbossa",
    name: "Concordant STE + excess discordant V1–V3",
  },
];

const AVNRT_FINDING_IDS = new Set<FindingId>(["avnrtTypical", "avnrtAtypical"]);

const AVNRT_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "avnrtTypical",
    short: "Typical",
    name: "Slow–fast · short RP · P-on-T",
  },
  {
    id: "avnrtAtypical",
    short: "Atypical",
    name: "Fast–slow · long RP · inverted P",
  },
];

const AVRT_FINDING_IDS = new Set<FindingId>([
  "avrtOrthoLeft",
  "avrtOrthoRight",
  "avrtAntiLeft",
  "avrtAntiRight",
]);

const AVRT_OPTIONS: { id: FindingId; short: string; name: string }[] = [
  {
    id: "avrtOrthoLeft",
    short: "Ortho · L",
    name: "Down AVN · up left Kent · narrow QRS",
  },
  {
    id: "avrtOrthoRight",
    short: "Ortho · R",
    name: "Down AVN · up right Kent · narrow QRS",
  },
  {
    id: "avrtAntiLeft",
    short: "Anti · L",
    name: "Down left Kent · up AVN · wide delta",
  },
  {
    id: "avrtAntiRight",
    short: "Anti · R",
    name: "Down right Kent · up AVN · wide delta",
  },
];

/** Keep expand panels open briefly after last option cleared */
const EXPAND_HOLD_MS = 2000;
type ExpandHoldKey = "bbb" | "chb" | "flutter" | "vf" | "vt" | "paced" | "stemi" | "avnrt" | "avrt" | "pvc" | "pac";
const expandHoldUntil: Record<ExpandHoldKey, number> = {
  bbb: 0,
  chb: 0,
  flutter: 0,
  vf: 0,
  vt: 0,
  paced: 0,
  stemi: 0,
  avnrt: 0,
  avrt: 0,
  pvc: 0,
  pac: 0,
};
const expandHoldTimers: Record<ExpandHoldKey, number | null> = {
  bbb: null,
  chb: null,
  flutter: null,
  vf: null,
  vt: null,
  paced: null,
  stemi: null,
  avnrt: null,
  avrt: null,
  pvc: null,
  pac: null,
};
let expandResync: (() => void) | null = null;

function holdExpandOpen(key: ExpandHoldKey) {
  expandHoldUntil[key] = performance.now() + EXPAND_HOLD_MS;
  if (expandHoldTimers[key] != null) window.clearTimeout(expandHoldTimers[key]!);
  expandHoldTimers[key] = window.setTimeout(() => {
    expandHoldTimers[key] = null;
    expandHoldUntil[key] = 0;
    expandResync?.();
  }, EXPAND_HOLD_MS + 30);
}

function expandHeld(key: ExpandHoldKey): boolean {
  return performance.now() < expandHoldUntil[key];
}

function clearExpandHold(key: ExpandHoldKey) {
  if (expandHoldTimers[key] != null) {
    window.clearTimeout(expandHoldTimers[key]!);
    expandHoldTimers[key] = null;
  }
  expandHoldUntil[key] = 0;
}

type AppState = {
  finding: FindingId;
  playing: boolean;
  ventRateBpm: number;
  /** Multiplier on animation time (independent of physiologic HR) */
  playbackSpeed: number;
  elapsed: number;
  heartVisible: boolean;
  vectorsOn: boolean;
  fieldOn: boolean;
  leadsOn: boolean;
  /** Custom His–Purkinje lesions (empty = use finding defaults) */
  customBlocks: BundleBlockId[];
  /** True when user is driving EKG from customBlocks rather than a preset finding */
  customBlockMode: boolean;
  /** Post-cardioversion timeline (keeps absolute strip sampler after settling into target) */
  cvRecovery: {
    from: FindingId;
    to: FindingId;
    durationSec: number;
    targetCycleSec: number;
    /** Wall-clock elapsed when the shock was delivered */
    shockAtSec: number;
    /** Prior-rhythm cycle length (for pre-shock strip history) */
    fromCycleSec: number;
    /** True once recovery arc finished — UI shows target, sampler stays continuous */
    settled: boolean;
  } | null;
  /** Preferred post-shock rhythm (default NSR) */
  cvTarget: FindingId;
  upload: UploadedEkg | null;
  stim: StimState;
  /** Myocardial ectopy / pace focus when finding uses field-first activation */
  ectopySite: EctopySiteId | null;
  /** PVC teaching strip: coupling pattern + RNG seed for random */
  pvcPattern: PvcPatternId;
  pvcSeed: number;
  /** Underlying device mode when showing pace malfunctions (drives which leads appear) */
  pacedBaseMode: Exclude<DeviceLeadMode, "none">;
};

function buildUI(root: HTMLElement): {
  ekgHost: HTMLElement;
  els: Record<string, HTMLElement>;
} {
  const segmentToggles = SEGMENT_META.filter((s) => s.id !== "myocardiumA" && s.id !== "myocardiumV")
    .map(
      (g) => `
      <label class="vessel-toggle">
        <input type="checkbox" data-segment="${g.id}" ${g.defaultOn ? "checked" : ""} />
        <span class="swatch" style="background:${g.color}"></span>
        <span>${g.label}</span>
      </label>`,
    )
    .join("");

  const bbbGroupButton = `<button type="button" id="btn-bbb" data-bbb-group title="Bundle branch / fascicular blocks">
      BBB<small>RBB · LBB · fascicles</small>
    </button>`;

  const bbbOptionsHtml = `
            <div class="finding-expand bbb-options" id="bbb-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Block which pathway?</span>
                    <button type="button" id="btn-block-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="bbb-lesion-grid" id="branch-block-grid">
                    ${BUNDLE_BLOCK_OPTIONS.map(
                      (o) => `<button type="button" class="bbb-lesion-chip" data-bundle-block="${o.id}">
                        <span class="bbb-lesion-short">${o.short}</span>
                        <span class="bbb-lesion-name">${o.label}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="bbb-result">Select one or more tracts</div>
                </div>
              </div>
            </div>`;

  const chbGroupButton = `<button type="button" id="btn-chb" data-chb-group title="Complete heart block · escape rhythm">
      CHB<small>3° · pick escape</small>
    </button>`;

  const chbOptionsHtml = `
            <div class="finding-expand chb-options" id="chb-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Escape focus?</span>
                    <button type="button" id="btn-chb-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="chb-escape-grid">
                    ${CHB_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-chb-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="chb-result">Select junctional or ventricular escape</div>
                </div>
              </div>
            </div>`;

  const flutterGroupButton = `<button type="button" id="btn-flutter" data-flutter-group title="Atrial flutter · circuit direction">
      Flutter<small>CCW · CW</small>
    </button>`;

  const flutterOptionsHtml = `
            <div class="finding-expand flutter-options" id="flutter-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Circuit direction?</span>
                    <button type="button" id="btn-flutter-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="flutter-dir-grid">
                    ${FLUTTER_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-flutter-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="flutter-result">Select counterclockwise or clockwise</div>
                </div>
              </div>
            </div>`;

  const pvcGroupButton = `<button type="button" id="btn-pvc" data-pvc-group title="Premature ventricular complex · site & frequency">
      PVC<small>Site · ratio</small>
    </button>`;

  const pvcOptionsHtml = `
            <div class="finding-expand pvc-options" id="pvc-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Ventricular focus?</span>
                    <button type="button" id="btn-pvc-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="ectopy-site-grid" id="pvc-site-grid">
                    ${VENTRICULAR_ECTOPY_SITES.map(
                      (s) => `<button type="button" class="ectopy-site-chip" data-pvc-site="${s.id}" title="${s.label}">${s.short}</button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-head" style="margin-top:0.55rem">
                    <span>How often?</span>
                  </div>
                  <div class="chb-escape-grid" id="pvc-pattern-grid">
                    ${PVC_PATTERNS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-pvc-pattern="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.label}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="pvc-result">Pick a site and PVC ratio</div>
                </div>
              </div>
            </div>`;

  const pacGroupButton = `<button type="button" id="btn-pac" data-pac-group title="Premature atrial complex · ectopic focus">
      PAC<small>Atrial site</small>
    </button>`;

  const pacOptionsHtml = `
            <div class="finding-expand pac-options" id="pac-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Atrial focus?</span>
                    <button type="button" id="btn-pac-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="ectopy-site-grid" id="pac-site-grid">
                    ${ATRIAL_ECTOPY_SITES.map(
                      (s) => `<button type="button" class="ectopy-site-chip" data-pac-site="${s.id}" title="${s.label}">${s.short}</button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="pac-result">Pick an atrial PAC site</div>
                </div>
              </div>
            </div>`;

  const vfGroupButton = `<button type="button" id="btn-vf" data-vf-group title="Ventricular fibrillation">
      VF<small>Coarse · Fine</small>
    </button>`;

  const vfOptionsHtml = `
            <div class="finding-expand vf-options" id="vf-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Amplitude?</span>
                    <button type="button" id="btn-vf-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="vf-amp-grid">
                    ${VF_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-vf-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="vf-result">Select coarse or fine VF</div>
                </div>
              </div>
            </div>`;

  const vtGroupButton = `<button type="button" id="btn-vt" data-vt-group title="Ventricular tachycardia">
      VT<small>Mono · LBBB · RBBB · Poly</small>
    </button>`;

  const vtOptionsHtml = `
            <div class="finding-expand vt-options" id="vt-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Which VT?</span>
                    <button type="button" id="btn-vt-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="vt-type-grid">
                    ${VT_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-vt-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="vt-result">Select monomorphic, LBBB, RBBB, poly, or TdP</div>
                </div>
              </div>
            </div>`;

  const pacedGroupButton = `<button type="button" id="btn-paced" data-paced-group title="Paced rhythms · device modes & failures">
      Pace<small>AAI · VVI · His · BiV</small>
    </button>`;

  const pacedOptionsHtml = `
            <div class="finding-expand paced-options" id="paced-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Mode or malfunction?</span>
                    <button type="button" id="btn-paced-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="paced-type-grid">
                    ${PACED_MODE_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-paced-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-head paced-fail-head"><span>Malfunction</span></div>
                  <div class="chb-escape-grid" id="paced-fail-grid">
                    ${PACED_FAIL_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-paced-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="paced-base-wrap" id="paced-base-wrap" hidden>
                    <div class="finding-expand-head"><span>Device mode (leads shown)</span></div>
                    <div class="chb-escape-grid" id="paced-base-grid">
                      ${PACED_BASE_MODES.map(
                        (o) => `<button type="button" class="chb-escape-chip" data-paced-base="${o.mode}">
                          <span class="chb-escape-short">${o.short}</span>
                          <span class="chb-escape-name">${o.name}</span>
                        </button>`,
                      ).join("")}
                    </div>
                  </div>
                  <div class="finding-expand-result" id="paced-result">Select pacing mode or malfunction</div>
                </div>
              </div>
            </div>`;

  const stemiGroupButton = `<button type="button" id="btn-stemi" data-stemi-group title="STEMI territories and equivalents">
      STEMI<small>Territories · equivalents</small>
    </button>`;

  const stemiOptionsHtml = `
            <div class="finding-expand stemi-options" id="stemi-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Territory or equivalent?</span>
                    <button type="button" id="btn-stemi-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="stemi-type-grid">
                    ${STEMI_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-stemi-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="stemi-result">Select STEMI territory or equivalent</div>
                </div>
              </div>
            </div>`;

  const avnrtGroupButton = `<button type="button" id="btn-avnrt" data-avnrt-group title="AV-nodal reentrant tachycardia · typical vs atypical">
      AVNRT<small>Typical · atypical</small>
    </button>`;

  const avnrtOptionsHtml = `
            <div class="finding-expand avnrt-options" id="avnrt-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Typical or atypical?</span>
                    <button type="button" id="btn-avnrt-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="avnrt-type-grid">
                    ${AVNRT_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-avnrt-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="avnrt-result">Select typical (slow–fast) or atypical (fast–slow)</div>
                </div>
              </div>
            </div>`;

  const avrtGroupButton = `<button type="button" id="btn-avrt" data-avrt-group title="AV reentrant tachycardia · ortho/anti · left/right Kent">
      AVRT<small>Ortho · anti · L/R Kent</small>
    </button>`;

  const avrtOptionsHtml = `
            <div class="finding-expand avrt-options" id="avrt-options" aria-hidden="true" style="display:none">
              <div class="finding-expand-inner">
                <div class="finding-expand-panel">
                  <div class="finding-expand-head">
                    <span>Circuit & Kent side</span>
                    <button type="button" id="btn-avrt-clear" class="finding-expand-clear">Clear</button>
                  </div>
                  <div class="chb-escape-grid" id="avrt-type-grid">
                    ${AVRT_OPTIONS.map(
                      (o) => `<button type="button" class="chb-escape-chip" data-avrt-finding="${o.id}">
                        <span class="chb-escape-short">${o.short}</span>
                        <span class="chb-escape-name">${o.name}</span>
                      </button>`,
                    ).join("")}
                  </div>
                  <div class="finding-expand-result" id="avrt-result">Select orthodromic/antidromic and left/right Kent</div>
                </div>
              </div>
            </div>`;

  const findingButtonHtml: string[] = [];
  let bbbInserted = false;
  let chbInserted = false;
  let flutterInserted = false;
  let pvcInserted = false;
  let pacInserted = false;
  let vfInserted = false;
  let vtInserted = false;
  let pacedInserted = false;
  let stemiInserted = false;
  let avnrtInserted = false;
  let avrtInserted = false;
  for (const f of FINDINGS) {
    if (f.category === "bbb") {
      if (!bbbInserted) {
        findingButtonHtml.push(bbbGroupButton);
        findingButtonHtml.push(bbbOptionsHtml);
        bbbInserted = true;
      }
      continue;
    }
    if (CHB_FINDING_IDS.has(f.id)) {
      if (!chbInserted) {
        findingButtonHtml.push(chbGroupButton);
        findingButtonHtml.push(chbOptionsHtml);
        chbInserted = true;
      }
      continue;
    }
    if (FLUTTER_FINDING_IDS.has(f.id)) {
      if (!flutterInserted) {
        findingButtonHtml.push(flutterGroupButton);
        findingButtonHtml.push(flutterOptionsHtml);
        flutterInserted = true;
      }
      continue;
    }
    if (f.id === "pvc") {
      if (!pvcInserted) {
        findingButtonHtml.push(pvcGroupButton);
        findingButtonHtml.push(pvcOptionsHtml);
        pvcInserted = true;
      }
      continue;
    }
    if (f.id === "pac") {
      if (!pacInserted) {
        findingButtonHtml.push(pacGroupButton);
        findingButtonHtml.push(pacOptionsHtml);
        pacInserted = true;
      }
      continue;
    }
    if (AVNRT_FINDING_IDS.has(f.id)) {
      if (!avnrtInserted) {
        findingButtonHtml.push(avnrtGroupButton);
        findingButtonHtml.push(avnrtOptionsHtml);
        avnrtInserted = true;
      }
      continue;
    }
    if (AVRT_FINDING_IDS.has(f.id)) {
      if (!avrtInserted) {
        findingButtonHtml.push(avrtGroupButton);
        findingButtonHtml.push(avrtOptionsHtml);
        avrtInserted = true;
      }
      continue;
    }
    if (VT_FINDING_IDS.has(f.id)) {
      if (!vtInserted) {
        findingButtonHtml.push(vtGroupButton);
        findingButtonHtml.push(vtOptionsHtml);
        vtInserted = true;
      }
      continue;
    }
    if (VF_FINDING_IDS.has(f.id)) {
      if (!vfInserted) {
        findingButtonHtml.push(vfGroupButton);
        findingButtonHtml.push(vfOptionsHtml);
        vfInserted = true;
      }
      continue;
    }
    if (PACED_FINDING_IDS.has(f.id)) {
      if (!pacedInserted) {
        findingButtonHtml.push(pacedGroupButton);
        findingButtonHtml.push(pacedOptionsHtml);
        pacedInserted = true;
      }
      continue;
    }
    if (STEMI_FINDING_IDS.has(f.id)) {
      if (!stemiInserted) {
        findingButtonHtml.push(stemiGroupButton);
        findingButtonHtml.push(stemiOptionsHtml);
        stemiInserted = true;
      }
      continue;
    }
    findingButtonHtml.push(`
    <button type="button" data-finding="${f.id}" title="${f.name}" ${f.id === "nsr" ? 'class="active"' : ""}>
      ${f.short}<small>${f.rateLabel}</small>
    </button>`);
  }
  if (!avnrtInserted) {
    findingButtonHtml.push(avnrtGroupButton);
    findingButtonHtml.push(avnrtOptionsHtml);
  }
  if (!avrtInserted) {
    findingButtonHtml.push(avrtGroupButton);
    findingButtonHtml.push(avrtOptionsHtml);
  }
  if (!vtInserted) {
    findingButtonHtml.push(vtGroupButton);
    findingButtonHtml.push(vtOptionsHtml);
  }
  if (!vfInserted) {
    findingButtonHtml.push(vfGroupButton);
    findingButtonHtml.push(vfOptionsHtml);
  }
  if (!pacedInserted) {
    findingButtonHtml.push(pacedGroupButton);
    findingButtonHtml.push(pacedOptionsHtml);
  }
  if (!stemiInserted) {
    findingButtonHtml.push(stemiGroupButton);
    findingButtonHtml.push(stemiOptionsHtml);
  }
  if (!flutterInserted) {
    findingButtonHtml.push(flutterGroupButton);
    findingButtonHtml.push(flutterOptionsHtml);
  }
  if (!pvcInserted) {
    findingButtonHtml.push(pvcGroupButton);
    findingButtonHtml.push(pvcOptionsHtml);
  }
  if (!pacInserted) {
    findingButtonHtml.push(pacGroupButton);
    findingButtonHtml.push(pacOptionsHtml);
  }
  if (!chbInserted) {
    findingButtonHtml.push(chbGroupButton);
    findingButtonHtml.push(chbOptionsHtml);
  }
  if (!bbbInserted) {
    findingButtonHtml.push(bbbGroupButton);
    findingButtonHtml.push(bbbOptionsHtml);
  }
  const findingButtons = findingButtonHtml.join("");

  root.innerHTML = `
    <div id="stage">
      <section class="view-pane" id="view-3d" aria-label="3D conduction system">
        <div id="viewport"></div>
        <div class="pane-chrome">
          <span class="phase-chip" id="phase-chip">—</span>
          <button type="button" class="view-reset" id="btn-view-reset" title="Reset 3D camera to default view">
            Reset view
          </button>
        </div>
      </section>
      <div id="splitter" role="separator" aria-orientation="vertical" aria-label="Resize panes" tabindex="0"></div>
      <section class="view-pane" id="view-ekg" aria-label="Live EKG tracing">
        <div class="ekg-header">
          <div class="ekg-header-left">
            <h2>12-lead · scrub to explore</h2>
            <div class="ekg-view-toggle" role="group" aria-label="EKG layout">
              <button type="button" class="ekg-view-btn" id="btn-ekg-grid" aria-pressed="true" title="Classic 3×4 grid with rhythm strip">
                Grid
              </button>
              <button type="button" class="ekg-view-btn" id="btn-ekg-channels" aria-pressed="false" title="All 12 leads stacked, one row each">
                12-channel
              </button>
            </div>
          </div>
          <div class="ekg-meta">
            <span class="meta-pill" id="meta-finding">NSR</span>
            <span class="meta-pill" id="meta-rate">70 bpm</span>
            <div class="ekg-calipers" id="ekg-calipers">
              <button type="button" class="caliper-btn" id="btn-calipers" aria-pressed="false" title="Measure intervals on the strip">
                Calipers
              </button>
              <button type="button" class="caliper-btn" id="btn-calipers-march" aria-pressed="false" hidden title="Repeat the measured interval across the strip">
                March out
              </button>
              <span class="meta-pill caliper-readout" id="caliper-readout" hidden>—</span>
            </div>
          </div>
        </div>
        <div class="ekg-body" id="ekg-host"></div>
        <div class="ekg-footer" id="ekg-footer">
          Drag / swipe the EKG to scrub · playing auto-pauses while scrubbing.
        </div>
      </section>
    </div>

    <div class="hud">
      <header class="brand">
        <h1>EKG View</h1>
      </header>

      <div class="panel-shell" id="panel-shell">
        <aside class="panel" id="panel" aria-label="Controls">
          <div class="panel-top">
            <h2>Findings</h2>
            <button type="button" class="panel-collapse" id="btn-collapse" title="Hide panel" aria-label="Hide panel">
              <span class="collapse-chevron collapse-chevron--side" aria-hidden="true">‹</span>
              <svg class="collapse-chevron collapse-chevron--down" viewBox="0 0 12 12" aria-hidden="true">
                <path d="M2.2 4.2 L6 8 L9.8 4.2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
          </div>

          <div class="finding-readout">
            <div class="label">Selected</div>
            <div class="value" id="finding-name">Normal sinus rhythm</div>
            <div class="detail" id="finding-detail">SA → AV → His → bundles → Purkinje</div>
          </div>

          <div class="transport">
            <h3>Playback</h3>
            <div class="transport-row">
              <button type="button" id="btn-play" class="active">Pause</button>
              <button type="button" id="btn-reset">Reset</button>
              <button type="button" id="btn-heart">Heart</button>
            </div>
            <div class="transport-row">
              <button type="button" id="btn-vectors">Vectors</button>
              <button type="button" id="btn-field">Field</button>
              <button type="button" id="btn-leads">Leads</button>
            </div>
            <div class="transport-row">
              <button type="button" id="btn-stim" title="Click to arm, then click anywhere on pathways or grey landmarks to pace. Click again to cancel.">Stimulate</button>
            </div>
            <div class="cv-row">
              <span class="cv-label" id="cv-label">Post-shock</span>
              <div class="cv-select" id="cv-select">
                <div class="cv-select-trigger-wrap">
                  <input
                    type="search"
                    class="cv-select-trigger"
                    id="cv-target-input"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-expanded="false"
                    aria-controls="cv-target-menu"
                    aria-labelledby="cv-label"
                    placeholder="Search rhythm…"
                    value="NSR"
                    autocomplete="off"
                    spellcheck="false"
                    title="Rhythm to recover into — type to search"
                  />
                  <span class="cv-select-chevron" aria-hidden="true">▾</span>
                </div>
                <div class="cv-select-menu" id="cv-target-menu" role="listbox" hidden>
                  <div class="cv-select-empty" id="cv-target-empty" hidden>No matching rhythms</div>
                  ${FINDINGS.map(
                    (f) =>
                      `<button type="button" class="cv-select-option${f.id === "nsr" ? " active" : ""}" role="option" data-cv-target="${f.id}" aria-selected="${f.id === "nsr"}">${f.short}<small>${f.name}</small></button>`,
                  ).join("")}
                </div>
              </div>
              <button type="button" id="btn-cv" title="Cardioversion / defibrillation → selected rhythm">Cardiovert / Defib</button>
            </div>
            <p class="stim-hint" id="stim-hint" hidden>Click pathways or grey landmarks to pace (one site at a time). Click Stimulate again when done.</p>
            <div class="ectopy-site" id="ectopy-site" hidden>
              <div class="ectopy-site-label" id="ectopy-site-label">Ectopy site</div>
              <div class="ectopy-site-grid" id="ectopy-site-grid">
                ${VENTRICULAR_ECTOPY_SITES.map(
                    (s) =>
                    `<button type="button" class="ectopy-site-chip" data-ectopy-site="${s.id}" title="${s.label}">${s.short}</button>`,
                ).join("")}
              </div>
            </div>
            <div class="slider-row rate-row">
              <label for="rate-input">Rate</label>
              <input id="rate-slider" type="range" min="30" max="300" value="70" step="1" />
              <div class="num-wrap">
                <input id="rate-input" type="number" min="30" max="300" step="1" value="70" aria-label="Ventricular rate" />
                <span class="unit">bpm</span>
              </div>
            </div>
            <div class="slider-row speed-row">
              <label for="speed-input">Speed</label>
              <input id="speed-slider" type="range" min="0" max="200" value="100" step="5" />
              <div class="num-wrap">
                <input id="speed-input" type="number" min="0" max="200" step="5" value="100" aria-label="Depolarization animation speed" />
                <span class="unit">%</span>
              </div>
            </div>
          </div>

          <div class="upload-block">
            <h3>Upload EKG</h3>
            <p class="upload-hint">
              Paper 12-lead, strip image, CSV, JSON, or HL7 aECG XML.
            </p>
            <label class="upload-drop" id="upload-drop" for="ekg-file">
              <span class="upload-drop-title">Choose file</span>
              <span class="upload-drop-sub">or drag &amp; drop here</span>
            </label>
            <div class="upload-busy" id="upload-busy" hidden aria-live="polite" aria-busy="true">
              <span class="upload-busy-spinner" aria-hidden="true"></span>
              <span class="upload-busy-text" id="upload-busy-text">Processing image…</span>
            </div>
            <input
              id="ekg-file"
              type="file"
              accept="image/*,.csv,.txt,.json,.xml,text/csv,application/json,text/xml,application/xml"
              hidden
            />
            <div class="upload-preview" id="upload-preview" hidden>
              <button type="button" class="upload-thumb-btn" id="upload-thumb-btn" title="Click to enlarge" hidden>
                <img id="upload-thumb" alt="Uploaded EKG with lead split overlay" />
                <span class="upload-thumb-zoom">Click to enlarge</span>
              </button>
              <div class="upload-split-caption" id="upload-split-caption" hidden>
                Colored boxes = lead splits — click image to adjust &amp; reprocess
              </div>
              <div class="upload-meta" id="upload-meta"></div>
              <div class="upload-match" id="upload-match" hidden>
                For education only — not a diagnosis
              </div>
              <div class="upload-actions">
                <button type="button" id="btn-export-csv" class="upload-export">Download CSV</button>
                <button type="button" id="btn-export-xml" class="upload-export">Download aECG XML</button>
                <button type="button" id="btn-clear-upload" class="upload-clear">Clear upload</button>
              </div>
            </div>
          </div>

          <div class="presets">
            <h3>EKG findings</h3>
            <input
              id="finding-search"
              type="search"
              placeholder="Findings or PhysioNet: mitdb, afdb, 100…"
              autocomplete="off"
              spellcheck="false"
              aria-label="Search EKG findings and PhysioNet records"
            />
            <div class="finding-empty" id="finding-empty" hidden>No matching findings</div>
            <div class="preset-grid" id="finding-grid">
              ${findingButtons}
            </div>
            <div class="physionet-block" id="physionet-block" hidden>
              <h3>PhysioNet</h3>
              <p class="physionet-examples">
                Examples:
                <code>mitdb</code>
                <code>mitdb/100</code>
                <code>afdb</code>
                <code>nsrdb</code>
                <code>vfdb</code>
                <code>svdb</code>
                <code>afib</code>
                <code>arrhythmia</code>
              </p>
              <p class="physionet-hint" id="physionet-hint">Click a record to load ~12s into the EKG pane</p>
              <div class="physionet-results" id="physionet-results"></div>
            </div>
          </div>

          <div class="legend">
            <h3>Pathways</h3>
            <div class="vessel-actions">
              <button type="button" id="btn-seg-all">All</button>
              <button type="button" id="btn-seg-none">None</button>
            </div>
            <div class="vessel-toggles" id="segment-toggles">
              ${segmentToggles}
            </div>
          </div>
        </aside>
        <button type="button" class="panel-expand" id="btn-expand" title="Show panel" aria-label="Show panel">Panel</button>
      </div>

      <div id="seg-tooltip" class="seg-tooltip" hidden>
        <div class="seg-tooltip-group"></div>
        <div class="seg-tooltip-name"></div>
        <div class="seg-tooltip-detail"></div>
      </div>
    </div>
  `;

  const ekgHost = root.querySelector("#ekg-host") as HTMLElement;

  // Full-viewport lightbox must live on <body>, not inside the scrolling panel
  let lightbox = document.getElementById("upload-lightbox");
  if (!lightbox) {
    lightbox = document.createElement("div");
    lightbox.id = "upload-lightbox";
    lightbox.className = "upload-lightbox";
    lightbox.hidden = true;
    document.body.appendChild(lightbox);
  }
  lightbox.innerHTML = `
      <button type="button" class="upload-lightbox-backdrop" id="upload-lightbox-close" aria-label="Close enlarged EKG"></button>
      <div class="upload-lightbox-panel" role="dialog" aria-modal="true" aria-label="Enlarged uploaded EKG">
        <div class="upload-lightbox-header">
          <div class="upload-lightbox-toolbar" id="upload-split-toolbar" hidden>
            <p class="upload-lightbox-hint" id="upload-split-hint">Drag boxes or resize handles to adjust lead crops, then reprocess.</p>
            <button type="button" class="upload-export" id="upload-split-reprocess">Reprocess</button>
          </div>
          <button type="button" class="upload-lightbox-x" id="upload-lightbox-x" aria-label="Close">×</button>
        </div>
        <div class="upload-split-stage" id="upload-split-stage">
          <img id="upload-lightbox-img" alt="Enlarged uploaded EKG" />
          <div class="upload-split-overlay" id="upload-split-overlay" hidden></div>
        </div>
      </div>`;

  const ids = [
    "phase-chip",
    "meta-finding",
    "meta-rate",
    "btn-calipers",
    "btn-calipers-march",
    "caliper-readout",
    "btn-ekg-grid",
    "btn-ekg-channels",
    "ekg-footer",
    "panel-shell",
    "btn-collapse",
    "btn-expand",
    "finding-name",
    "finding-detail",
    "btn-play",
    "btn-reset",
    "btn-view-reset",
    "btn-heart",
    "btn-vectors",
    "btn-field",
    "btn-leads",
    "btn-stim",
    "btn-cv",
    "cv-select",
    "cv-target-input",
    "cv-target-menu",
    "cv-target-empty",
    "stim-hint",
    "ectopy-site",
    "ectopy-site-label",
    "ectopy-site-grid",
    "rate-slider",
    "rate-input",
    "speed-slider",
    "speed-input",
    "branch-block-grid",
    "btn-block-clear",
    "btn-bbb",
    "bbb-options",
    "bbb-result",
    "btn-chb",
    "chb-options",
    "chb-result",
    "chb-escape-grid",
    "btn-chb-clear",
    "btn-flutter",
    "flutter-options",
    "flutter-result",
    "flutter-dir-grid",
    "btn-flutter-clear",
    "btn-pvc",
    "pvc-options",
    "pvc-result",
    "pvc-site-grid",
    "pvc-pattern-grid",
    "btn-pvc-clear",
    "btn-pac",
    "pac-options",
    "pac-result",
    "pac-site-grid",
    "btn-pac-clear",
    "btn-vf",
    "vf-options",
    "vf-result",
    "vf-amp-grid",
    "btn-vf-clear",
    "btn-vt",
    "vt-options",
    "vt-result",
    "vt-type-grid",
    "btn-vt-clear",
    "btn-paced",
    "paced-options",
    "paced-result",
    "paced-type-grid",
    "paced-fail-grid",
    "paced-base-wrap",
    "paced-base-grid",
    "btn-paced-clear",
    "btn-stemi",
    "stemi-options",
    "stemi-result",
    "stemi-type-grid",
    "btn-stemi-clear",
    "btn-avnrt",
    "avnrt-options",
    "avnrt-result",
    "avnrt-type-grid",
    "btn-avnrt-clear",
    "btn-avrt",
    "avrt-options",
    "avrt-result",
    "avrt-type-grid",
    "btn-avrt-clear",
    "finding-grid",
    "finding-search",
    "finding-empty",
    "physionet-block",
    "physionet-hint",
    "physionet-results",
    "btn-seg-all",
    "btn-seg-none",
    "segment-toggles",
    "seg-tooltip",
    "viewport",
    "ekg-file",
    "upload-drop",
    "upload-busy",
    "upload-busy-text",
    "upload-preview",
    "upload-thumb",
    "upload-thumb-btn",
    "upload-split-caption",
    "upload-meta",
    "upload-match",
    "upload-lightbox",
    "upload-lightbox-img",
    "upload-lightbox-close",
    "upload-lightbox-x",
    "upload-split-toolbar",
    "upload-split-stage",
    "upload-split-overlay",
    "upload-split-reprocess",
    "upload-split-hint",
    "btn-export-csv",
    "btn-export-xml",
    "btn-clear-upload",
  ] as const;

  const els: Record<string, HTMLElement> = {};
  for (const id of ids) {
    els[id] =
      (root.querySelector(`#${id}`) as HTMLElement | null) ??
      (document.getElementById(id) as HTMLElement);
  }

  return { ekgHost, els };
}

function main() {
  const app = document.querySelector("#app");
  if (!app) throw new Error("#app missing");

  const { ekgHost, els } = buildUI(app as HTMLElement);
  const canvasHost = els["viewport"];

  const state: AppState = {
    finding: "nsr",
    playing: true,
    ventRateBpm: 70,
    playbackSpeed: 1,
    elapsed: 0,
    heartVisible: true,
    vectorsOn: false,
    fieldOn: false,
    leadsOn: false,
    customBlocks: [],
    customBlockMode: false,
    cvRecovery: null,
    cvTarget: "nsr",
    upload: null,
    stim: { armed: false, site: null },
    ectopySite: null,
    pvcPattern: defaultPvcPattern() as PvcPatternId,
    pvcSeed: 1,
    pacedBaseMode: "ddd",
  };

  let pvcSchedule: PvcSchedule = buildPvcSchedule(state.pvcPattern, state.pvcSeed);

  const segmentVisibility: Record<SegmentId, boolean> = Object.fromEntries(
    SEGMENT_META.map((g) => [g.id, g.defaultOn]),
  ) as Record<SegmentId, boolean>;

  const ekg = createEkgTrace(ekgHost);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1218);
  scene.fog = new THREE.FogExp2(0x0a1218, 0.045);

  const bgGeo = new THREE.SphereGeometry(40, 32, 16);
  const bgMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      colorCenter: { value: new THREE.Color(0x12202a) },
      colorEdge: { value: new THREE.Color(0x070c10) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 colorCenter;
      uniform vec3 colorEdge;
      varying vec3 vPos;
      void main() {
        vec3 n = normalize(vPos);
        float h = n.y * 0.5 + 0.5;
        float glow = pow(max(0.0, 1.0 - length(n.xz)), 2.2) * 0.2;
        vec3 col = mix(colorEdge, colorCenter, h);
        col += vec3(0.08, 0.18, 0.22) * glow;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  scene.add(new THREE.Mesh(bgGeo, bgMat));

  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const defaultCamPos = new THREE.Vector3();
  const defaultTarget = new THREE.Vector3();
  camera.up.set(0, 1, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  canvasHost.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.8;
  controls.maxDistance = 16;
  controls.update();

  /** While true, splitter/resize re-applies the default AP framing in the 3D pane. */
  let framingLocked = true;
  controls.addEventListener("start", () => {
    framingLocked = false;
  });

  /**
   * AP head-on. Puts the AV node on the geometric center of the 3D pane
   * (NDC 0,0), and fits the full model to the pane aspect.
   */
  function frameDefaultView() {
    const w = Math.max(1, canvasHost.clientWidth || window.innerWidth);
    const h = Math.max(1, canvasHost.clientHeight || window.innerHeight);
    camera.aspect = w / h;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();

    anatomy.updateMatrixWorld(true);
    // Center on the heart/conduction mass — not peripheral lead electrodes
    const box = new THREE.Box3().setFromObject(conduction.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const focus = sphere.center.clone();

    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const limFov = Math.min(vFov, hFov);
    // Slightly tighter than full-sphere so the heart fills the pane without clipping
    const dist = ((sphere.radius * 1.12) / Math.tan(limFov / 2) / 1.85) * 0.85;

    // AP: camera on +Z looking at heart center
    camera.position.set(focus.x, focus.y, focus.z + dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(focus);
    controls.target.copy(focus);
    controls.minDistance = Math.max(0.6, dist * 0.25);
    controls.maxDistance = Math.max(10, dist * 4);
    controls.update();

    defaultCamPos.copy(camera.position);
    defaultTarget.copy(focus);
  }

  function resetCameraView() {
    framingLocked = true;
    frameDefaultView();
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.45));
  const key = new THREE.DirectionalLight(0xfff0e8, 1.0);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88c8e0, 0.45);
  fill.position.set(-3, 1, -2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x3db8c8, 0.25);
  rim.position.set(0, -2, -4);
  scene.add(rim);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(2.4, 64),
    new THREE.MeshStandardMaterial({
      color: 0x152028,
      roughness: 0.9,
      metalness: 0.1,
      transparent: true,
      opacity: 0.55,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.55;
  scene.add(ground);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.35, 2.42, 64),
    new THREE.MeshBasicMaterial({
      color: 0x3db8c8,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = -1.54;
  scene.add(ring);

  const conduction: ConductionSystem = createConductionSystem();
  const anatomy = new THREE.Group();
  anatomy.name = "anatomy";
  // Match cath-view in-chest long-axis pose (apex left / inferior / slightly anterior)
  applyAnatomicOrientation(anatomy);
  anatomy.add(conduction.root);
  // Re-center after rotation so the heart sits on the world origin / pane center
  anatomy.updateMatrixWorld(true);
  {
    const box = new THREE.Box3().setFromObject(anatomy);
    const c = box.getCenter(new THREE.Vector3());
    anatomy.position.sub(c);
  }
  scene.add(anatomy);

  const stimMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.04, 16, 12),
    new THREE.MeshBasicMaterial({
      color: 0xf0c040,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
    }),
  );
  stimMarker.visible = false;
  stimMarker.name = "stimMarker";
  scene.add(stimMarker);

  const deviceLeads = createDeviceLeads();
  deviceLeads.root.position.copy(conduction.root.position);
  anatomy.add(deviceLeads.root);

  const vectors = createActivationVectors(conduction.getPathwayProbes());
  vectors.root.position.copy(conduction.root.position);
  anatomy.add(vectors.root);

  // Surface ECG leads stay in the patient/chest frame — not rotated with the heart
  const leads = createLeadPositions();
  scene.add(leads.root);

  // Place ground under the heart (ignore far electrode markers)
  {
    anatomy.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(conduction.root);
    const minY = box.min.y;
    ground.position.y = minY - 0.12;
    ring.position.y = minY - 0.11;
  }

  function applySegmentVisibility() {
    for (const g of SEGMENT_META) {
      conduction.setSegmentVisibility(g.id, segmentVisibility[g.id]);
    }
    if (!isAvrtFinding(state.finding) || state.upload) {
      segmentVisibility.accessory = false;
      segmentVisibility.accessoryR = false;
      conduction.setAccessoryVisible(false, "both");
    }
    const isFlutter = FLUTTER_FINDING_IDS.has(state.finding);
    if (!isFlutter && !segmentVisibility.flutter) {
      conduction.setSegmentVisibility("flutter", false);
    }
    if (!isAvnrtFinding(state.finding)) {
      if (!segmentVisibility.avnrtSlow) conduction.setSegmentVisibility("avnrtSlow", false);
      if (!segmentVisibility.avnrtFast) conduction.setSegmentVisibility("avnrtFast", false);
    }
    conduction.setAvNodeEmphasis(isAvnrtFinding(state.finding) && !state.upload);
  }
  applySegmentVisibility();

  function applyRateToEkg() {
    if (state.cvRecovery) {
      if (state.cvRecovery.settled) {
        state.cvRecovery.targetCycleSec = cycleSecForRate(
          getFinding(state.cvRecovery.to),
          state.ventRateBpm,
        );
        ekg.setCycleSec(state.cvRecovery.targetCycleSec);
        bindCardioversionSample(true);
      } else {
        ekg.setCycleSec(state.cvRecovery.durationSec);
      }
      return;
    }
    if (state.upload) {
      ekg.setCycleSec(state.upload.durationSec);
      return;
    }
    if (state.stim.site) {
      ekg.setCycleSec(
        cycleSecForRate(
          { ...getFinding("nsr"), cycleSec: 0.9, ventRateBpm: 60 },
          state.ventRateBpm,
        ),
      );
      return;
    }
    // Multi-beat PVC / PAC strips use absolute schedule seconds
    if (state.finding === "pvc") {
      ekg.setCycleSec(pvcSchedule.cycleSec);
      return;
    }
    if (state.finding === "pac") {
      ekg.setCycleSec(PAC_STRIP_CYCLE_SEC);
      return;
    }
    const f = getFinding(state.finding);
    ekg.setCycleSec(cycleSecForRate(f, state.ventRateBpm));
  }

  function syncRateUI(bpm: number) {
    state.ventRateBpm = Math.max(30, Math.min(300, Math.round(bpm)));
    (els["rate-slider"] as HTMLInputElement).value = String(state.ventRateBpm);
    (els["rate-input"] as HTMLInputElement).value = String(state.ventRateBpm);
    els["meta-rate"].textContent = `${state.ventRateBpm} bpm`;
    applyRateToEkg();
  }

  function activeBundleBlocks(): BundleBlockId[] {
    if (state.customBlockMode) return state.customBlocks;
    return blocksForFinding(state.finding);
  }

  function setFindingExpand(el: HTMLElement, open: boolean) {
    if (open) {
      const wasHidden = el.style.display === "none" || getComputedStyle(el).display === "none";
      if (wasHidden) {
        el.style.display = "grid";
        el.classList.remove("is-open");
        void el.offsetHeight;
      }
      el.classList.add("is-open");
      el.setAttribute("aria-hidden", "false");
      return;
    }
    if (!el.classList.contains("is-open")) {
      el.style.display = "none";
      el.setAttribute("aria-hidden", "true");
      return;
    }
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (!el.classList.contains("is-open")) el.style.display = "none";
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== el) return;
      if (e.propertyName !== "grid-template-rows" && e.propertyName !== "opacity") return;
      el.removeEventListener("transitionend", onEnd);
      finish();
    };
    el.addEventListener("transitionend", onEnd);
    window.setTimeout(finish, 420);
  }

  function syncBranchBlockCheckboxes() {
    const active = new Set(activeBundleBlocks());
    els["branch-block-grid"].querySelectorAll<HTMLButtonElement>("button[data-bundle-block]").forEach((btn) => {
      const id = btn.dataset.bundleBlock as BundleBlockId;
      btn.classList.toggle("active", active.has(id));
    });
    const blocks = activeBundleBlocks();
    const desc = describeBundleBlocks(blocks);
    const bbbActive =
      !(state.cvRecovery && !state.cvRecovery.settled) &&
      (state.customBlockMode || BBB_FINDING_IDS.has(state.finding) || blocks.length > 0);
    if (bbbActive) clearExpandHold("bbb");
    const bbbOpen = bbbActive || expandHeld("bbb");
    setFindingExpand(els["bbb-options"], bbbOpen);
    els["btn-bbb"].classList.toggle("active", bbbOpen && !state.upload && !state.stim.site);
    els["bbb-result"].textContent =
      blocks.length === 0
        ? "Select one or more tracts · click a bundle on the model to lesion"
        : `${desc.name} · ${desc.detail}`;
  }

  function syncChbOptions() {
    // Never open CHB from BBB custom lesions (trifascicular used to set finding=av3)
    const chbActive =
      !(state.cvRecovery && !state.cvRecovery.settled) &&
      !state.customBlockMode &&
      CHB_FINDING_IDS.has(state.finding);
    if (chbActive) clearExpandHold("chb");
    const chbOpen = chbActive || expandHeld("chb");
    setFindingExpand(els["chb-options"], chbOpen);
    els["btn-chb"].classList.toggle("active", chbOpen && !state.upload && !state.stim.site);
    els["chb-escape-grid"].querySelectorAll<HTMLButtonElement>("button[data-chb-finding]").forEach((btn) => {
      btn.classList.toggle("active", chbActive && btn.dataset.chbFinding === state.finding);
    });
    if (chbActive) {
      const f = getFinding(state.finding);
      els["chb-result"].textContent = `${f.short} · ${f.detail}`;
    } else {
      els["chb-result"].textContent = "Select junctional or ventricular escape";
    }
  }

  function syncFlutterOptions() {
    const flutterActive =
      !(state.cvRecovery && !state.cvRecovery.settled) && FLUTTER_FINDING_IDS.has(state.finding);
    if (flutterActive) clearExpandHold("flutter");
    const flutterOpen = flutterActive || expandHeld("flutter");
    setFindingExpand(els["flutter-options"], flutterOpen);
    els["btn-flutter"].classList.toggle("active", flutterOpen && !state.upload && !state.stim.site);
    els["flutter-dir-grid"].querySelectorAll<HTMLButtonElement>("button[data-flutter-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.flutterFinding === state.finding);
    });
    if (flutterActive) {
      const f = getFinding(state.finding);
      els["flutter-result"].textContent = `${f.short} · ${f.detail}`;
    } else {
      els["flutter-result"].textContent = "Select counterclockwise or clockwise";
    }
  }

  function syncVfOptions() {
    const vfActive =
      !(state.cvRecovery && !state.cvRecovery.settled) && VF_FINDING_IDS.has(state.finding);
    if (vfActive) clearExpandHold("vf");
    const vfOpen = vfActive || expandHeld("vf");
    setFindingExpand(els["vf-options"], vfOpen);
    els["btn-vf"].classList.toggle("active", vfOpen && !state.upload && !state.stim.site);
    els["vf-amp-grid"].querySelectorAll<HTMLButtonElement>("button[data-vf-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.vfFinding === state.finding);
    });
    if (vfActive) {
      const f = getFinding(state.finding);
      els["vf-result"].textContent = `${f.short} · ${f.detail}`;
    } else {
      els["vf-result"].textContent = "Select coarse or fine VF";
    }
  }

  function syncVtOptions() {
    const vtActive =
      !(state.cvRecovery && !state.cvRecovery.settled) && VT_FINDING_IDS.has(state.finding);
    if (vtActive) clearExpandHold("vt");
    const vtOpen = vtActive || expandHeld("vt");
    setFindingExpand(els["vt-options"], vtOpen);
    els["btn-vt"].classList.toggle("active", vtOpen && !state.upload && !state.stim.site);
    els["vt-type-grid"].querySelectorAll<HTMLButtonElement>("button[data-vt-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.vtFinding === state.finding);
    });
    if (vtActive) {
      const f = getFinding(state.finding);
      els["vt-result"].textContent = `${f.short} · ${f.detail}`;
    } else {
      els["vt-result"].textContent = "Select monomorphic, LBBB, RBBB, poly, or TdP";
    }
  }

  function pacedModeLabel(mode: DeviceLeadMode): string {
    return PACED_BASE_MODES.find((m) => m.mode === mode)?.short ?? mode.toUpperCase();
  }

  function syncPacedOptions() {
    const pacedActive =
      !(state.cvRecovery && !state.cvRecovery.settled) && PACED_FINDING_IDS.has(state.finding);
    if (pacedActive) clearExpandHold("paced");
    const pacedOpen = pacedActive || expandHeld("paced");
    setFindingExpand(els["paced-options"], pacedOpen);
    els["btn-paced"].classList.toggle("active", pacedOpen && !state.upload && !state.stim.site);
    els["paced-type-grid"].querySelectorAll<HTMLButtonElement>("button[data-paced-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pacedFinding === state.finding);
    });
    els["paced-fail-grid"].querySelectorAll<HTMLButtonElement>("button[data-paced-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pacedFinding === state.finding);
    });
    const fail = isPacingFailureFinding(state.finding);
    els["paced-base-wrap"].hidden = !fail;
    els["paced-base-grid"].querySelectorAll<HTMLButtonElement>("button[data-paced-base]").forEach((btn) => {
      btn.classList.toggle("active", fail && btn.dataset.pacedBase === state.pacedBaseMode);
    });
    if (pacedActive) {
      const f = getFinding(state.finding);
      if (fail) {
        const leads = deviceModeForFinding(state.finding, state.pacedBaseMode);
        const leadNames = PACED_BASE_MODES.find((m) => m.mode === leads)?.name ?? leads;
        els["paced-result"].textContent = `${f.short} · ${pacedModeLabel(state.pacedBaseMode)} (${leadNames}) · ${f.detail}`;
      } else {
        els["paced-result"].textContent = `${f.short} · ${f.detail}`;
      }
    } else {
      els["paced-result"].textContent = "Select pacing mode or malfunction";
    }
  }

  function syncStemiOptions() {
    const stemiActive =
      !(state.cvRecovery && !state.cvRecovery.settled) && STEMI_FINDING_IDS.has(state.finding);
    if (stemiActive) clearExpandHold("stemi");
    const stemiOpen = stemiActive || expandHeld("stemi");
    setFindingExpand(els["stemi-options"], stemiOpen);
    els["btn-stemi"].classList.toggle("active", stemiOpen && !state.upload && !state.stim.site);
    els["stemi-type-grid"].querySelectorAll<HTMLButtonElement>("button[data-stemi-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.stemiFinding === state.finding);
    });
    if (stemiActive) {
      const f = getFinding(state.finding);
      els["stemi-result"].textContent = `${f.short} · ${f.detail}`;
    } else {
      els["stemi-result"].textContent = "Select STEMI territory or equivalent";
    }
  }

  function syncAvnrtOptions() {
    const avnrtActive =
      !(state.cvRecovery && !state.cvRecovery.settled) && AVNRT_FINDING_IDS.has(state.finding);
    if (avnrtActive) clearExpandHold("avnrt");
    const avnrtOpen = avnrtActive || expandHeld("avnrt");
    setFindingExpand(els["avnrt-options"], avnrtOpen);
    els["btn-avnrt"].classList.toggle("active", avnrtOpen && !state.upload && !state.stim.site);
    els["avnrt-type-grid"].querySelectorAll<HTMLButtonElement>("button[data-avnrt-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.avnrtFinding === state.finding);
    });
    if (avnrtActive) {
      const f = getFinding(state.finding);
      els["avnrt-result"].textContent = `${f.short} · ${f.detail}`;
    } else {
      els["avnrt-result"].textContent = "Select typical (slow–fast) or atypical (fast–slow)";
    }
  }

  function syncAvrtOptions() {
    const avrtActive =
      !(state.cvRecovery && !state.cvRecovery.settled) && AVRT_FINDING_IDS.has(state.finding);
    if (avrtActive) clearExpandHold("avrt");
    const avrtOpen = avrtActive || expandHeld("avrt");
    setFindingExpand(els["avrt-options"], avrtOpen);
    els["btn-avrt"].classList.toggle("active", avrtOpen && !state.upload && !state.stim.site);
    els["avrt-type-grid"].querySelectorAll<HTMLButtonElement>("button[data-avrt-finding]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.avrtFinding === state.finding);
    });
    if (avrtActive) {
      const f = getFinding(state.finding);
      els["avrt-result"].textContent = isAvrtAntiFinding(state.finding)
        ? `${f.short} · ${f.detail} · watch pre-excitation field → delta`
        : `${f.short} · ${f.detail}`;
    } else {
      els["avrt-result"].textContent = "Select orthodromic/antidromic and left/right Kent";
    }
  }

  function syncEctopySiteUI() {
    // PVC / PAC sites live in finding expand panels; this strip is for VT only.
    const uses =
      (state.finding === "vt" ||
        state.finding === "vtMonoLbbb" ||
        state.finding === "vtMonoRbbb") &&
      !state.upload &&
      !state.stim.site;
    els["ectopy-site"].hidden = !uses;
    if (!uses) return;
    els["ectopy-site-label"].textContent = "Ectopy site";
    const sites = VENTRICULAR_ECTOPY_SITES;
    const active = state.ectopySite ?? defaultEctopySite(state.finding);
    const grid = els["ectopy-site-grid"];
    grid.innerHTML = sites
      .map(
        (s) =>
          `<button type="button" class="ectopy-site-chip${s.id === active ? " active" : ""}" data-ectopy-site="${s.id}" title="${s.label}">${s.short}</button>`,
      )
      .join("");
  }

  function applyPacConfig(opts?: { resetElapsed?: boolean }) {
    if (state.finding !== "pac" || state.upload || state.stim.site) return;
    ekg.setCustomSample((t) =>
      samplePacPattern(t, (state.ectopySite ?? defaultEctopySite("pac") ?? "raLow") as EctopySiteId),
    );
    ekg.setCycleSec(PAC_STRIP_CYCLE_SEC);
    if (opts?.resetElapsed !== false) state.elapsed = 0;
  }

  function syncPacUI() {
    const pacActive = state.finding === "pac" && !state.upload && !state.stim.site;
    if (pacActive) clearExpandHold("pac");
    const pacOpen = pacActive || expandHeld("pac");
    setFindingExpand(els["pac-options"], pacOpen);
    els["btn-pac"].classList.toggle("active", pacActive);
    const site = state.ectopySite ?? defaultEctopySite("pac");
    els["pac-site-grid"].querySelectorAll<HTMLButtonElement>("button[data-pac-site]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pacSite === site);
    });
    if (pacActive) {
      els["pac-result"].textContent = `${ectopySiteById(site!).label} · ectopic P′`;
    } else {
      els["pac-result"].textContent = "Pick an atrial PAC site";
    }
  }

  function applyPvcConfig(opts?: { resetElapsed?: boolean }) {
    pvcSchedule = buildPvcSchedule(state.pvcPattern, state.pvcSeed);
    if (state.finding !== "pvc" || state.upload || state.stim.site) return;
    ekg.setCustomSample((t) =>
      samplePvcPattern(
        t,
        state.pvcPattern,
        state.pvcSeed,
        (state.ectopySite ?? defaultEctopySite("pvc") ?? "rvot") as EctopySiteId,
      ),
    );
    ekg.setCycleSec(pvcSchedule.cycleSec);
    if (opts?.resetElapsed !== false) state.elapsed = 0;
  }

  function syncPvcUI() {
    const pvcActive = state.finding === "pvc" && !state.upload && !state.stim.site;
    if (pvcActive) clearExpandHold("pvc");
    const pvcOpen = pvcActive || expandHeld("pvc");
    setFindingExpand(els["pvc-options"], pvcOpen);
    els["btn-pvc"].classList.toggle("active", pvcActive);
    const site = state.ectopySite ?? defaultEctopySite("pvc");
    els["pvc-site-grid"].querySelectorAll<HTMLButtonElement>("button[data-pvc-site]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pvcSite === site);
    });
    els["pvc-pattern-grid"].querySelectorAll<HTMLButtonElement>("button[data-pvc-pattern]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.pvcPattern === state.pvcPattern);
    });
    if (pvcActive) {
      const siteLabel = ectopySiteById(site!).short;
      const pat = PVC_PATTERNS.find((p) => p.id === state.pvcPattern);
      els["pvc-result"].textContent = `${siteLabel} · ${pat?.label ?? state.pvcPattern}`;
    } else {
      els["pvc-result"].textContent = "Pick a site and PVC ratio";
    }
  }

  function ensureTeachOverlaysForFinding(id: FindingId) {
    // Teaching field for BBB / antidromic AVRT — never auto-toggle Vectors
    // (PAC/PVC used to flip Vectors on and felt random).
    if (isAvrtAntiFinding(id) || BBB_FINDING_IDS.has(id)) {
      if (!state.fieldOn) setField(true);
    }
  }

  function syncFindingUI() {
    const f = getFinding(state.finding);
    const stimSite = state.stim.site;
    const blocks = activeBundleBlocks();
    const blockDesc = describeBundleBlocks(blocks);
    const usingCustomBlocks = state.customBlockMode && blocks.length > 0;

    if (stimSite && !state.upload) {
      els["finding-name"].textContent = stimLabel(stimSite);
      els["finding-detail"].textContent = stimDetail(stimSite);
      els["meta-finding"].textContent = "STIM";
    } else if (state.cvRecovery && !state.cvRecovery.settled) {
      const to = getFinding(state.cvRecovery.to);
      els["finding-name"].textContent = "Post-cardioversion recovery";
      els["finding-detail"].textContent = `From ${getFinding(state.cvRecovery.from).short} · returning toward ${to.short}`;
      els["meta-finding"].textContent = `CV → ${to.short}`;
    } else if (usingCustomBlocks || (BBB_FINDING_IDS.has(state.finding) && blocks.length > 0 && !state.upload)) {
      els["finding-name"].textContent = blockDesc.name;
      els["finding-detail"].textContent = blockDesc.detail;
      els["meta-finding"].textContent = blockDesc.short;
    } else {
      els["finding-name"].textContent = state.upload ? `Upload · ${state.upload.name}` : f.name;
      els["finding-detail"].textContent = state.upload
        ? `${layoutLabel(state.upload.layout)} · ${state.upload.availableLeads.join(", ")} · ~${state.upload.rateBpm} bpm`
        : f.detail;
      els["meta-finding"].textContent = state.upload ? "UPLOAD" : f.short;
    }
    els["finding-grid"].querySelectorAll<HTMLButtonElement>("button[data-finding]").forEach((btn) => {
      btn.classList.toggle(
        "active",
        !state.upload &&
          !stimSite &&
          !usingCustomBlocks &&
          !(state.cvRecovery && !state.cvRecovery.settled) &&
          btn.dataset.finding === state.finding,
      );
    });
    ekg.setFinding(state.finding);
    ekg.setUpload(state.upload);
    if (stimSite && !state.upload) {
      ekg.setCustomSample((t) => sampleStim(stimSite, t));
      ekg.setCycleSec(cycleSecForRate({ ...f, cycleSec: 0.9, ventRateBpm: 60 }, state.ventRateBpm));
    } else if (state.cvRecovery) {
      ekg.setCycleSec(
        state.cvRecovery.settled ? state.cvRecovery.targetCycleSec : state.cvRecovery.durationSec,
      );
      bindCardioversionSample(state.cvRecovery.settled);
    } else if (usingCustomBlocks) {
      ekg.setCustomSample((t) => sampleFromBundleBlocks(blocks, t));
      ekg.setCycleSec(cycleSecForRate(f, state.ventRateBpm));
    } else if (state.finding === "pvc" && !state.upload) {
      applyPvcConfig({ resetElapsed: false });
    } else if (state.finding === "pac" && !state.upload) {
      applyPacConfig({ resetElapsed: false });
    } else {
      ekg.setCustomSample(null);
    }

    els["btn-stim"].classList.toggle("active", state.stim.armed || !!stimSite);
    els["stim-hint"].hidden = !state.stim.armed;
    canvasHost.classList.toggle("stim-armed", state.stim.armed);
    stimMarker.visible = !!stimSite && !state.upload;

    if (isAvrtFinding(state.finding) && !state.upload) {
      const side = avrtKentSide(state.finding);
      segmentVisibility.accessory = side === "left";
      segmentVisibility.accessoryR = side === "right";
      const leftInput = els["segment-toggles"].querySelector<HTMLInputElement>(
        'input[data-segment="accessory"]',
      );
      if (leftInput) leftInput.checked = side === "left";
      const rightInput = els["segment-toggles"].querySelector<HTMLInputElement>(
        'input[data-segment="accessoryR"]',
      );
      if (rightInput) rightInput.checked = side === "right";
      conduction.setAccessoryVisible(side === "left", "left");
      conduction.setAccessoryVisible(side === "right", "right");
    } else {
      // Kent tubes + tip beads only for AVRT findings
      segmentVisibility.accessory = false;
      segmentVisibility.accessoryR = false;
      const leftInput = els["segment-toggles"].querySelector<HTMLInputElement>(
        'input[data-segment="accessory"]',
      );
      if (leftInput) leftInput.checked = false;
      const rightInput = els["segment-toggles"].querySelector<HTMLInputElement>(
        'input[data-segment="accessoryR"]',
      );
      if (rightInput) rightInput.checked = false;
      conduction.setAccessoryVisible(false, "both");
    }
    if (FLUTTER_FINDING_IDS.has(state.finding) && !state.upload) {
      segmentVisibility.flutter = true;
      const input = els["segment-toggles"].querySelector<HTMLInputElement>(
        'input[data-segment="flutter"]',
      );
      if (input) input.checked = true;
    }
    if (isAvnrtFinding(state.finding) && !state.upload) {
      segmentVisibility.avnrtSlow = true;
      segmentVisibility.avnrtFast = true;
      for (const id of ["avnrtSlow", "avnrtFast"] as const) {
        const input = els["segment-toggles"].querySelector<HTMLInputElement>(
          `input[data-segment="${id}"]`,
        );
        if (input) input.checked = true;
      }
    }
    applySegmentVisibility();
    if (!(stimSite && !state.upload) && !state.cvRecovery) applyRateToEkg();

    const cvBusy = !!(state.cvRecovery && !state.cvRecovery.settled);
    conduction.setBlockSite(
      stimSite || state.upload || usingCustomBlocks || cvBusy
        ? "none"
        : blockSiteForFinding(state.finding),
    );
    conduction.setBranchBlocks(
      stimSite || state.upload ? [] : lesionSegmentsForBlocks(blocks),
    );
    deviceLeads.setMode(
      stimSite || state.upload || usingCustomBlocks || cvBusy
        ? "none"
        : deviceModeForFinding(state.finding, state.pacedBaseMode),
    );
    syncBranchBlockCheckboxes();
    syncChbOptions();
    syncFlutterOptions();
    syncVtOptions();
    syncVfOptions();
    syncPacedOptions();
    syncStemiOptions();
    syncAvnrtOptions();
    syncAvrtOptions();
    syncEctopySiteUI();
    syncPvcUI();
    syncPacUI();
    syncCardioversionUi();
  }

  function syncCardioversionUi() {
    const cvLive = !!(state.cvRecovery && !state.cvRecovery.settled);
    document.body.classList.toggle("cv-active", cvLive);
    const btn = els["btn-cv"] as HTMLButtonElement;
    const input = els["cv-target-input"] as HTMLInputElement;
    const menu = els["cv-target-menu"];
    const short = getFinding(state.cvTarget).short;
    input.disabled = cvLive;
    if (cvLive) setCvMenuOpen(false);
    // When menu closed, show the committed selection label
    if (menu.hidden) input.value = short;
    input.setAttribute("aria-expanded", menu.hidden ? "false" : "true");
    els["cv-select"].classList.toggle("is-open", !menu.hidden);
    els["cv-select"].classList.toggle("is-disabled", cvLive);
    menu.querySelectorAll<HTMLButtonElement>("[data-cv-target]").forEach((opt) => {
      const on = opt.dataset.cvTarget === state.cvTarget;
      opt.classList.toggle("active", on);
      opt.setAttribute("aria-selected", on ? "true" : "false");
    });
    btn.textContent = cvLive ? "Cancel CV / Defib" : "Cardiovert / Defib";
    btn.classList.toggle("active", cvLive);
    btn.title = cvLive
      ? "Cancel shock recovery and restore prior rhythm"
      : `Cardioversion / defibrillation → ${short}`;
  }

  function filterCvTargetOptions(query: string) {
    const q = query.trim();
    let visible = 0;
    els["cv-target-menu"].querySelectorAll<HTMLButtonElement>("[data-cv-target]").forEach((opt) => {
      const id = opt.dataset.cvTarget as FindingId;
      const show = findingMatchesQuery(getFinding(id), q);
      opt.hidden = !show;
      if (show) visible += 1;
    });
    els["cv-target-empty"].hidden = visible > 0;
  }

  function visibleCvOptions(): HTMLButtonElement[] {
    return [
      ...els["cv-target-menu"].querySelectorAll<HTMLButtonElement>("[data-cv-target]:not([hidden])"),
    ];
  }

  function setCvMenuOpen(open: boolean) {
    const menu = els["cv-target-menu"];
    const input = els["cv-target-input"] as HTMLInputElement;
    if (open && input.disabled) return;
    menu.hidden = !open;
    input.setAttribute("aria-expanded", open ? "true" : "false");
    els["cv-select"].classList.toggle("is-open", open);
    if (open) {
      filterCvTargetOptions(input.value === getFinding(state.cvTarget).short ? "" : input.value);
      const active = menu.querySelector<HTMLElement>(".cv-select-option.active:not([hidden])");
      (active ?? visibleCvOptions()[0])?.scrollIntoView({ block: "nearest" });
    } else {
      input.value = getFinding(state.cvTarget).short;
      filterCvTargetOptions("");
    }
  }

  function pickCvTarget(id: FindingId) {
    state.cvTarget = id;
    setCvMenuOpen(false);
    syncCardioversionUi();
  }

  function setStimArmed(armed: boolean) {
    state.stim.armed = armed;
    if (armed) {
      state.upload = null;
      ekg.setUpload(null);
      els["upload-preview"].hidden = true;
    }
    syncFindingUI();
    syncViewLabel();
  }

  /** One Stimulate button: arm to pick/relocate sites, or cancel when already armed. */
  function toggleStim() {
    if (state.stim.armed) {
      clearStim();
      return;
    }
    setStimArmed(true);
  }

  function applyStimSite(site: StimSite, worldPos: THREE.Vector3) {
    state.stim.site = site;
    // Stay armed so further clicks relocate the single stim site until Stimulate is toggled off.
    state.stim.armed = true;
    state.elapsed = 0;
    state.upload = null;
    ekg.setUpload(null);
    els["upload-preview"].hidden = true;
    stimMarker.position.copy(worldPos);
    stimMarker.visible = true;
    syncRateUI(60);
    syncFindingUI();
    syncViewLabel();
    setPlaying(true);
  }

  function clearStim() {
    state.stim.armed = false;
    state.stim.site = null;
    stimMarker.visible = false;
    ekg.setCustomSample(null);
    syncFindingUI();
    syncViewLabel();
  }

  function setFinding(id: FindingId) {
    state.finding = id;
    state.elapsed = 0;
    state.upload = null;
    state.cvRecovery = null;
    state.stim.armed = false;
    state.stim.site = null;
    state.customBlockMode = false;
    state.customBlocks = blocksForFinding(id);
    state.ectopySite = defaultEctopySite(id);
    stimMarker.visible = false;
    ekg.setUpload(null);
    ekg.setCustomSample(null);
    els["upload-preview"].hidden = true;
    const f = getFinding(id);
    syncRateUI(f.ventRateBpm);
    syncFindingUI();
    if (id === "pvc") applyPvcConfig({ resetElapsed: true });
    if (id === "pac") applyPacConfig({ resetElapsed: true });
    ensureTeachOverlaysForFinding(id);
  }

  function setPlaying(playing: boolean) {
    state.playing = playing;
    els["btn-play"].textContent = playing ? "Pause" : "Play";
    els["btn-play"].classList.toggle("active", playing);
  }

  function syncViewLabel() {
    const label = document.querySelector(".pane-label");
    if (!label) return;
    const bits = ["Conduction"];
    if (state.vectorsOn) bits.push("vectors");
    if (state.fieldOn) bits.push("field");
    if (state.leadsOn) bits.push("leads");
    if (state.stim.site) bits.push("stim");
    if (state.stim.armed) bits.push("pick site");
    label.textContent = bits.length > 1 ? bits.join(" · ") : "Conduction";
  }

  function setVectors(on: boolean) {
    state.vectorsOn = on;
    vectors.setMeanVisible(on);
    els["btn-vectors"].classList.toggle("active", on);
    syncViewLabel();
  }

  function setField(on: boolean) {
    state.fieldOn = on;
    vectors.setFieldVisible(on);
    els["btn-field"].classList.toggle("active", on);
    syncViewLabel();
  }

  function setLeads(on: boolean) {
    state.leadsOn = on;
    leads.setVisible(on);
    els["btn-leads"].classList.toggle("active", on);
    syncViewLabel();
  }

  syncRateUI(70);
  syncFindingUI();
  expandResync = () => {
    syncBranchBlockCheckboxes();
    syncChbOptions();
    syncFlutterOptions();
    syncVtOptions();
    syncVfOptions();
    syncPacedOptions();
    syncStemiOptions();
    syncAvnrtOptions();
    syncAvrtOptions();
    syncEctopySiteUI();
    syncPvcUI();
    syncPacUI();
  };
  setPlaying(true);
  setVectors(false);
  setField(false);
  setLeads(false);

  ekg.onScrub((deltaSec) => {
    if (state.playing) setPlaying(false);
    state.elapsed = Math.max(0, state.elapsed + deltaSec);
  });

  const FOOTER_SCRUB =
    "← → scrub (pauses) · ↑ ↓ rate · drag/swipe also scrubs.";
  const FOOTER_CALIPERS =
    "Click two points or drag to set calipers · ← → / wheel still scrub · March out repeats the interval.";

  function syncEkgDisplayModeUI() {
    const mode = ekg.getDisplayMode();
    (els["btn-ekg-grid"] as HTMLButtonElement).setAttribute("aria-pressed", mode === "grid" ? "true" : "false");
    (els["btn-ekg-channels"] as HTMLButtonElement).setAttribute(
      "aria-pressed",
      mode === "channels" ? "true" : "false",
    );
  }

  function syncCalipersUI() {
    const on = ekg.getCalipers().enabled;
    const march = ekg.getCalipers().march;
    const btn = els["btn-calipers"] as HTMLButtonElement;
    const marchBtn = els["btn-calipers-march"] as HTMLButtonElement;
    const readout = els["caliper-readout"];
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    marchBtn.hidden = !on;
    marchBtn.setAttribute("aria-pressed", march ? "true" : "false");
    els["ekg-footer"].textContent = on ? FOOTER_CALIPERS : FOOTER_SCRUB;
    if (!on) {
      readout.hidden = true;
      readout.textContent = "—";
    }
  }

  ekg.onCalipersChange((r) => {
    const readout = els["caliper-readout"];
    if (!ekg.getCalipers().enabled) {
      readout.hidden = true;
      return;
    }
    if (!r) {
      readout.hidden = true;
      readout.textContent = "—";
      return;
    }
    readout.hidden = false;
    readout.textContent = `${r.intervalMs} ms · ${r.bpm}/min`;
  });

  els["btn-ekg-grid"].addEventListener("click", () => {
    ekg.setDisplayMode("grid");
    syncEkgDisplayModeUI();
  });
  els["btn-ekg-channels"].addEventListener("click", () => {
    ekg.setDisplayMode("channels");
    syncEkgDisplayModeUI();
  });
  syncEkgDisplayModeUI();

  els["btn-calipers"].addEventListener("click", () => {
    const next = !ekg.getCalipers().enabled;
    ekg.setCalipersEnabled(next);
    if (!next) ekg.setCalipersMarch(false);
    syncCalipersUI();
  });

  els["btn-calipers-march"].addEventListener("click", () => {
    if (!ekg.getCalipers().enabled) return;
    ekg.setCalipersMarch(!ekg.getCalipers().march);
    syncCalipersUI();
  });

  syncCalipersUI();

  els["finding-grid"].addEventListener("click", (e) => {
    const bbbBtn = (e.target as HTMLElement).closest("#btn-bbb");
    if (bbbBtn) {
      const open = els["bbb-options"].classList.contains("is-open");
      if (open && (BBB_FINDING_IDS.has(state.finding) || state.customBlockMode)) {
        holdExpandOpen("bbb");
        setFinding("nsr");
      } else {
        setFinding("rbbb");
      }
      return;
    }
    const blockOpt = (e.target as HTMLElement).closest("button[data-bundle-block]");
    if (blockOpt) {
      const id = (blockOpt as HTMLElement).dataset.bundleBlock as BundleBlockId;
      const next = new Set(activeBundleBlocks());
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const blocks = [...next];
      state.customBlocks = blocks;
      state.customBlockMode = blocks.length > 0;
      state.finding = findingIdForBlocks(blocks);
      if (blocks.length === 0) holdExpandOpen("bbb");
      state.elapsed = 0;
      state.upload = null;
      ekg.setUpload(null);
      els["upload-preview"].hidden = true;
      state.stim.armed = false;
      state.stim.site = null;
      stimMarker.visible = false;
      state.cvRecovery = null;
      ekg.setCustomSample(null);
      syncRateUI(getFinding(state.finding).ventRateBpm);
      syncFindingUI();
      syncViewLabel();
      if (blocks.length > 0) ensureTeachOverlaysForFinding(state.finding);
      setPlaying(true);
      return;
    }
    const chbBtn = (e.target as HTMLElement).closest("#btn-chb");
    if (chbBtn) {
      const open = els["chb-options"].classList.contains("is-open");
      if (open && CHB_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("chb");
        setFinding("nsr");
      } else {
        setFinding("av3Junctional");
      }
      return;
    }
    const chbOpt = (e.target as HTMLElement).closest("button[data-chb-finding]");
    if (chbOpt) {
      const id = (chbOpt as HTMLElement).dataset.chbFinding as FindingId;
      setFinding(id);
      return;
    }
    const flutterBtn = (e.target as HTMLElement).closest("#btn-flutter");
    if (flutterBtn) {
      const open = els["flutter-options"].classList.contains("is-open");
      if (open && FLUTTER_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("flutter");
        setFinding("nsr");
      } else {
        setFinding("aflutterCcw");
      }
      return;
    }
    const flutterOpt = (e.target as HTMLElement).closest("button[data-flutter-finding]");
    if (flutterOpt) {
      const id = (flutterOpt as HTMLElement).dataset.flutterFinding as FindingId;
      setFinding(id);
      return;
    }
    const pvcBtn = (e.target as HTMLElement).closest("#btn-pvc");
    if (pvcBtn) {
      if (state.finding === "pvc") {
        // Click again disables PVCs (back to NSR) and closes the panel
        clearExpandHold("pvc");
        setFinding("nsr");
      } else if (els["pvc-options"].classList.contains("is-open")) {
        // Panel held open after Clear — close without re-enabling
        clearExpandHold("pvc");
        setFindingExpand(els["pvc-options"], false);
        els["btn-pvc"].classList.remove("active");
      } else {
        setFinding("pvc");
      }
      return;
    }
    const pvcSite = (e.target as HTMLElement).closest("button[data-pvc-site]");
    if (pvcSite) {
      const id = (pvcSite as HTMLElement).dataset.pvcSite as EctopySiteId;
      state.ectopySite = id;
      if (state.finding !== "pvc") setFinding("pvc");
      else {
        applyPvcConfig({ resetElapsed: true });
        syncPvcUI();
      }
      return;
    }
    const pvcPat = (e.target as HTMLElement).closest("button[data-pvc-pattern]");
    if (pvcPat) {
      const id = (pvcPat as HTMLElement).dataset.pvcPattern as PvcPatternId;
      state.pvcPattern = id;
      if (id === "random") state.pvcSeed = (state.pvcSeed % 997) + 1;
      if (state.finding !== "pvc") setFinding("pvc");
      else {
        applyPvcConfig({ resetElapsed: true });
        syncPvcUI();
      }
      return;
    }
    const pacBtn = (e.target as HTMLElement).closest("#btn-pac");
    if (pacBtn) {
      if (state.finding === "pac") {
        clearExpandHold("pac");
        setFinding("nsr");
      } else if (els["pac-options"].classList.contains("is-open")) {
        clearExpandHold("pac");
        setFindingExpand(els["pac-options"], false);
        els["btn-pac"].classList.remove("active");
      } else {
        setFinding("pac");
      }
      return;
    }
    const pacSite = (e.target as HTMLElement).closest("button[data-pac-site]");
    if (pacSite) {
      const id = (pacSite as HTMLElement).dataset.pacSite as EctopySiteId;
      state.ectopySite = id;
      if (state.finding !== "pac") setFinding("pac");
      else {
        applyPacConfig({ resetElapsed: true });
        syncPacUI();
      }
      return;
    }
    const vfBtn = (e.target as HTMLElement).closest("#btn-vf");
    if (vfBtn) {
      const open = els["vf-options"].classList.contains("is-open");
      if (open && VF_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("vf");
        setFinding("nsr");
      } else {
        setFinding("vfCoarse");
      }
      return;
    }
    const vfOpt = (e.target as HTMLElement).closest("button[data-vf-finding]");
    if (vfOpt) {
      const id = (vfOpt as HTMLElement).dataset.vfFinding as FindingId;
      setFinding(id);
      return;
    }
    const vtBtn = (e.target as HTMLElement).closest("#btn-vt");
    if (vtBtn) {
      const open = els["vt-options"].classList.contains("is-open");
      if (open && VT_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("vt");
        setFinding("nsr");
      } else {
        setFinding("vt");
      }
      return;
    }
    const vtOpt = (e.target as HTMLElement).closest("button[data-vt-finding]");
    if (vtOpt) {
      const id = (vtOpt as HTMLElement).dataset.vtFinding as FindingId;
      setFinding(id);
      return;
    }
    const pacedBtn = (e.target as HTMLElement).closest("#btn-paced");
    if (pacedBtn) {
      const open = els["paced-options"].classList.contains("is-open");
      if (open && PACED_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("paced");
        setFinding("nsr");
      } else {
        setFinding("pacedAtrial");
      }
      return;
    }
    const pacedOpt = (e.target as HTMLElement).closest("button[data-paced-finding]");
    if (pacedOpt) {
      const id = (pacedOpt as HTMLElement).dataset.pacedFinding as FindingId;
      if (!isPacingFailureFinding(id)) {
        const mode = deviceModeForFinding(id);
        if (mode !== "none") state.pacedBaseMode = mode;
      }
      setFinding(id);
      return;
    }
    const pacedBase = (e.target as HTMLElement).closest("button[data-paced-base]");
    if (pacedBase) {
      const mode = (pacedBase as HTMLElement).dataset.pacedBase as Exclude<DeviceLeadMode, "none">;
      if (mode) {
        state.pacedBaseMode = mode;
        if (!isPacingFailureFinding(state.finding)) {
          // Jump to matching capture rhythm if user picks a mode while on a mode chip
          const match = PACED_MODE_OPTIONS.find((o) => deviceModeForFinding(o.id) === mode);
          if (match) setFinding(match.id);
          else syncPacedOptions();
        } else {
          deviceLeads.setMode(deviceModeForFinding(state.finding, state.pacedBaseMode));
          syncPacedOptions();
        }
      }
      return;
    }
    const stemiBtn = (e.target as HTMLElement).closest("#btn-stemi");
    if (stemiBtn) {
      const open = els["stemi-options"].classList.contains("is-open");
      if (open && STEMI_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("stemi");
        setFinding("nsr");
      } else {
        setFinding("stemiAnt");
      }
      return;
    }
    const stemiOpt = (e.target as HTMLElement).closest("button[data-stemi-finding]");
    if (stemiOpt) {
      const id = (stemiOpt as HTMLElement).dataset.stemiFinding as FindingId;
      setFinding(id);
      return;
    }
    const avnrtBtn = (e.target as HTMLElement).closest("#btn-avnrt");
    if (avnrtBtn) {
      const open = els["avnrt-options"].classList.contains("is-open");
      if (open && AVNRT_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("avnrt");
        setFinding("nsr");
      } else {
        setFinding("avnrtTypical");
      }
      return;
    }
    const avnrtOpt = (e.target as HTMLElement).closest("button[data-avnrt-finding]");
    if (avnrtOpt) {
      const id = (avnrtOpt as HTMLElement).dataset.avnrtFinding as FindingId;
      setFinding(id);
      return;
    }
    const avrtBtn = (e.target as HTMLElement).closest("#btn-avrt");
    if (avrtBtn) {
      const open = els["avrt-options"].classList.contains("is-open");
      if (open && AVRT_FINDING_IDS.has(state.finding)) {
        holdExpandOpen("avrt");
        setFinding("nsr");
      } else {
        setFinding("avrtOrthoLeft");
      }
      return;
    }
    const avrtOpt = (e.target as HTMLElement).closest("button[data-avrt-finding]");
    if (avrtOpt) {
      const id = (avrtOpt as HTMLElement).dataset.avrtFinding as FindingId;
      setFinding(id);
      return;
    }
    const btn = (e.target as HTMLElement).closest("button[data-finding]");
    if (!btn) return;
    const id = (btn as HTMLElement).dataset.finding as FindingId;
    setFinding(id);
  });

  const findingSearch = els["finding-search"] as HTMLInputElement;
  const findingEmpty = els["finding-empty"];
  const physioBlock = els["physionet-block"];
  const physioResults = els["physionet-results"];
  const physioHint = els["physionet-hint"];
  let physioSearchGen = 0;

  async function applyPhysioUpload(parsed: UploadedEkg) {
    if (state.upload?.imageUrl) URL.revokeObjectURL(state.upload.imageUrl);
    state.upload = parsed;
    state.stim.armed = false;
    state.stim.site = null;
    stimMarker.visible = false;
    ekg.setCustomSample(null);
    state.elapsed = 0;
    syncRateUI(parsed.rateBpm);
    syncFindingUI();
    const thumb = els["upload-thumb"] as HTMLImageElement;
    thumb.hidden = true;
    els["upload-thumb-btn"].hidden = true;
    els["upload-split-caption"].hidden = true;
    els["upload-preview"].hidden = false;
    els["upload-meta"].textContent = `${parsed.name} · ${layoutLabel(parsed.layout)} · ${parsed.availableLeads.join(", ")} · ~${parsed.rateBpm} bpm`;
    els["upload-match"].hidden = false;
    els["upload-match"].textContent = "For education only — not a diagnosis";
    setPlaying(true);
  }

  async function loadPhysioRecord(ref: PhysioRecordRef) {
    physioHint.textContent = `Loading ${ref.label}…`;
    try {
      const parsed = await loadPhysioNetRecord({
        database: ref.database,
        version: ref.version,
        record: ref.record,
        durationSec: 12,
      });
      await applyPhysioUpload(parsed);
      physioHint.textContent = `Loaded ${ref.label} · ${parsed.availableLeads.join(", ")}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not load PhysioNet record";
      physioHint.textContent = msg;
      els["upload-preview"].hidden = false;
      els["upload-meta"].textContent = msg;
    }
  }

  function renderPhysioResults(opts: {
    records: PhysioRecordRef[];
    projects: Awaited<ReturnType<typeof searchPhysioNetProjects>>;
    dbs: ReturnType<typeof curatedDbMatches>;
    query: string;
  }) {
    const { records, projects, dbs, query } = opts;
    physioResults.innerHTML = "";
    const hasAnything = records.length > 0 || projects.length > 0 || dbs.length > 0;
    physioBlock.hidden = !query.trim() || (!hasAnything && query.trim().length < 2);
    if (physioBlock.hidden) return;

    if (!hasAnything) {
      physioHint.textContent = "No matches — try one of the examples above";
      return;
    }

    physioHint.textContent = "Click a record to load ~12s into the EKG pane";

    for (const db of dbs.slice(0, 4)) {
      const row = document.createElement("div");
      row.className = "physionet-db";
      row.innerHTML = `<strong>${db.title}</strong><span>${db.slug} · ${db.records.length} records</span>`;
      physioResults.appendChild(row);
    }

    for (const ref of records.slice(0, 18)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "physionet-record";
      btn.innerHTML = `<span class="physionet-record-id">${ref.label}</span><small>${ref.detail}</small>`;
      btn.title = `Load ${ref.label} from PhysioNet`;
      btn.addEventListener("click", () => void loadPhysioRecord(ref));
      physioResults.appendChild(btn);
    }

    for (const p of projects.slice(0, 6)) {
      if (CURATED_HAS.has(p.slug)) continue;
      const a = document.createElement("a");
      a.className = "physionet-project";
      a.href = p.sourceUrl;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.innerHTML = `<span>${p.title}</span><small>${p.accessPolicy}${p.open ? " · open" : ""} · on PhysioNet ↗</small>`;
      physioResults.appendChild(a);
    }
  }

  const CURATED_HAS = new Set(
    ["mitdb", "nsrdb", "svdb", "afdb", "vfdb", "cudb"],
  );

  async function runPhysioSearch(q: string) {
    const gen = ++physioSearchGen;
    const records = searchCuratedRecords(q);
    const dbs = curatedDbMatches(q);
    let projects: Awaited<ReturnType<typeof searchPhysioNetProjects>> = [];
    try {
      if (q.trim().length >= 2) projects = await searchPhysioNetProjects(q);
    } catch {
      // Curated results still work without live API
      if (gen === physioSearchGen && records.length === 0 && dbs.length === 0) {
        physioHint.textContent =
          "PhysioNet API unreachable — curated teaching sets still searchable (mitdb, afdb…)";
      }
    }
    if (gen !== physioSearchGen) return;
    renderPhysioResults({ records, projects, dbs, query: q });
  }

  function filterFindings() {
    const q = findingSearch.value;
    let visible = 0;
    els["finding-grid"].querySelectorAll<HTMLButtonElement>("button[data-finding]").forEach((btn) => {
      const id = btn.dataset.finding as FindingId;
      const show = findingMatchesQuery(getFinding(id), q);
      btn.hidden = !show;
      if (show) visible += 1;
    });
    const bbbMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => f.category === "bbb" && findingMatchesQuery(f, q));
    const bbbBtn = els["btn-bbb"] as HTMLButtonElement;
    bbbBtn.hidden = !bbbMatch;
    if (bbbMatch) visible += 1;

    const chbMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => CHB_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const chbBtn = els["btn-chb"] as HTMLButtonElement;
    chbBtn.hidden = !chbMatch;
    if (chbMatch) visible += 1;

    const flutterMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => FLUTTER_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const flutterBtn = els["btn-flutter"] as HTMLButtonElement;
    flutterBtn.hidden = !flutterMatch;
    if (flutterMatch) visible += 1;

    const pvcMatch =
      q.trim().length === 0 || findingMatchesQuery(getFinding("pvc"), q);
    const pvcBtn = els["btn-pvc"] as HTMLButtonElement;
    pvcBtn.hidden = !pvcMatch;
    if (pvcMatch) visible += 1;

    const pacMatch =
      q.trim().length === 0 || findingMatchesQuery(getFinding("pac"), q);
    const pacBtn = els["btn-pac"] as HTMLButtonElement;
    pacBtn.hidden = !pacMatch;
    if (pacMatch) visible += 1;

    const vtMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => VT_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const vtBtn = els["btn-vt"] as HTMLButtonElement;
    vtBtn.hidden = !vtMatch;
    if (vtMatch) visible += 1;

    const vfMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => VF_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const vfBtn = els["btn-vf"] as HTMLButtonElement;
    vfBtn.hidden = !vfMatch;
    if (vfMatch) visible += 1;

    const pacedMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => PACED_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const pacedBtn = els["btn-paced"] as HTMLButtonElement;
    pacedBtn.hidden = !pacedMatch;
    if (pacedMatch) visible += 1;

    const stemiMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => STEMI_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const stemiBtn = els["btn-stemi"] as HTMLButtonElement;
    stemiBtn.hidden = !stemiMatch;
    if (stemiMatch) visible += 1;

    const avnrtMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => AVNRT_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const avnrtBtn = els["btn-avnrt"] as HTMLButtonElement;
    avnrtBtn.hidden = !avnrtMatch;
    if (avnrtMatch) visible += 1;

    const avrtMatch =
      q.trim().length === 0 ||
      FINDINGS.some((f) => AVRT_FINDING_IDS.has(f.id) && findingMatchesQuery(f, q));
    const avrtBtn = els["btn-avrt"] as HTMLButtonElement;
    avrtBtn.hidden = !avrtMatch;
    if (avrtMatch) visible += 1;

    // Auto-expand any group that has a matching option; collapse extras when search clears
    const qActive = q.trim().length > 0;
    if (qActive) {
      if (bbbMatch) setFindingExpand(els["bbb-options"], true);
      if (chbMatch) setFindingExpand(els["chb-options"], true);
      if (flutterMatch) setFindingExpand(els["flutter-options"], true);
      if (pvcMatch) setFindingExpand(els["pvc-options"], true);
      if (pacMatch) setFindingExpand(els["pac-options"], true);
      if (vtMatch) setFindingExpand(els["vt-options"], true);
      if (vfMatch) setFindingExpand(els["vf-options"], true);
      if (pacedMatch) setFindingExpand(els["paced-options"], true);
      if (stemiMatch) setFindingExpand(els["stemi-options"], true);
      if (avnrtMatch) setFindingExpand(els["avnrt-options"], true);
      if (avrtMatch) setFindingExpand(els["avrt-options"], true);
    } else {
      expandResync?.();
    }

    // Within open expandables, hide chips that don't match the query
    const filterFindingChips = (gridId: string, dataAttr: string) => {
      const grid = els[gridId];
      if (!grid) return;
      grid.querySelectorAll<HTMLButtonElement>(`button[${dataAttr}]`).forEach((btn) => {
        const id = btn.getAttribute(dataAttr) as FindingId;
        btn.hidden = qActive && !findingMatchesQuery(getFinding(id), q);
      });
    };
    filterFindingChips("chb-escape-grid", "data-chb-finding");
    filterFindingChips("flutter-dir-grid", "data-flutter-finding");
    filterFindingChips("vf-amp-grid", "data-vf-finding");
    filterFindingChips("vt-type-grid", "data-vt-finding");
    filterFindingChips("paced-type-grid", "data-paced-finding");
    filterFindingChips("paced-fail-grid", "data-paced-finding");
    filterFindingChips("stemi-type-grid", "data-stemi-finding");
    filterFindingChips("avnrt-type-grid", "data-avnrt-finding");
    filterFindingChips("avrt-type-grid", "data-avrt-finding");
    // BBB chips are lesion toggles (not one finding each) — keep them all visible when BBB opens

    findingEmpty.hidden = visible > 0 || q.trim().length === 0;
    void runPhysioSearch(q);
  }

  let searchTimer = 0;
  findingSearch.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => filterFindings(), 180);
  });

  els["btn-stim"].addEventListener("click", () => toggleStim());

  function flashCardioversion() {
    const flash = document.createElement("div");
    flash.className = "cv-flash";
    document.body.appendChild(flash);
    requestAnimationFrame(() => flash.classList.add("on"));
    window.setTimeout(() => {
      flash.classList.remove("on");
      window.setTimeout(() => flash.remove(), 280);
    }, 120);
  }

  function cardiovert() {
    // Second press during recovery cancels and restores the prior rhythm
    if (state.cvRecovery && !state.cvRecovery.settled) {
      cancelCardioversion();
      return;
    }

    flashCardioversion();
    clearStim();
    state.upload = null;
    ekg.setUpload(null);
    els["upload-preview"].hidden = true;
    state.customBlockMode = false;
    state.customBlocks = [];

    const from = state.finding;
    const to = state.cvTarget;
    const durationSec = cardioversionDurationSec(from);
    const fromCycleSec = cycleSecForRate(getFinding(from), state.ventRateBpm);
    const targetCycleSec = cycleSecForRate(getFinding(to), getFinding(to).ventRateBpm);
    const shockAtSec = state.elapsed;

    // Keep elapsed continuous so the rolling window still shows the old rhythm
    state.cvRecovery = {
      from,
      to,
      durationSec,
      targetCycleSec,
      shockAtSec,
      fromCycleSec,
      settled: false,
    };
    state.finding = to;
    ekg.setFinding(to);
    ekg.setCycleSec(durationSec);
    syncRateUI(getFinding(to).ventRateBpm);
    if (state.cvRecovery) {
      state.cvRecovery.targetCycleSec = cycleSecForRate(getFinding(to), state.ventRateBpm);
    }
    bindCardioversionSample(true);
    syncFindingUI();
    setPlaying(true);
  }

  function cancelCardioversion() {
    const from = state.cvRecovery?.from ?? "nsr";
    state.cvRecovery = null;
    ekg.setCustomSample(null);
    document.body.classList.remove("cv-active");
    // Restore prior finding without wiping strip time
    state.finding = from;
    state.customBlockMode = false;
    state.customBlocks = blocksForFinding(from);
    ekg.setFinding(from);
    syncRateUI(getFinding(from).ventRateBpm);
    syncFindingUI();
    setPlaying(true);
  }

  function bindCardioversionSample(preserveTrace: boolean) {
    const cv = state.cvRecovery;
    if (!cv) return;
    ekg.setCustomSample(
      (tAbs) =>
        sampleCardioversionAt(
          tAbs,
          cv.from,
          cv.durationSec,
          cv.targetCycleSec,
          cv.to,
          cv.shockAtSec,
          cv.fromCycleSec,
        ),
      {
        absolute: true,
        preserveTrace,
        tCycleAt: (elapsedSec) =>
          cardioversionWallTCycle(
            elapsedSec,
            cv.shockAtSec,
            cv.durationSec,
            cv.targetCycleSec,
            cv.fromCycleSec,
          ),
      },
    );
  }

  function finishCardioversionRecovery() {
    if (!state.cvRecovery || state.cvRecovery.settled) return;
    const to = state.cvRecovery.to;
    state.cvRecovery.settled = true;
    state.cvRecovery.targetCycleSec = cycleSecForRate(getFinding(to), state.ventRateBpm);
    state.finding = to;
    state.customBlockMode = false;
    state.customBlocks = [];
    ekg.setCycleSec(state.cvRecovery.targetCycleSec);
    bindCardioversionSample(true);
    syncFindingUI();
    setPlaying(true);
  }

  /** Once pre-shock history has scrolled off, drop the absolute CV sampler. */
  function maybeReleaseCardioversionSampler() {
    const cv = state.cvRecovery;
    if (!cv?.settled) return;
    if (state.elapsed < cv.shockAtSec + ekg.getWindowSec()) return;
    state.cvRecovery = null;
    ekg.setCustomSample(null, { preserveTrace: true });
    document.body.classList.remove("cv-active");
  }

  const cvInput = els["cv-target-input"] as HTMLInputElement;

  cvInput.addEventListener("focus", () => {
    if (cvInput.disabled) return;
    setCvMenuOpen(true);
    cvInput.select();
  });

  cvInput.addEventListener("click", (e) => {
    e.stopPropagation();
    if (cvInput.disabled) return;
    setCvMenuOpen(true);
  });

  cvInput.addEventListener("input", () => {
    if (cvInput.disabled) return;
    setCvMenuOpen(true);
    filterCvTargetOptions(cvInput.value);
  });

  cvInput.addEventListener("keydown", (e) => {
    if (cvInput.disabled) return;
    const opts = visibleCvOptions();
    const active = els["cv-target-menu"].querySelector<HTMLButtonElement>(
      ".cv-select-option.active:not([hidden])",
    );
    const idx = active ? opts.indexOf(active) : -1;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCvMenuOpen(true);
      const next = opts[Math.min(opts.length - 1, Math.max(0, idx + 1))] ?? opts[0];
      if (next?.dataset.cvTarget) {
        opts.forEach((o) => o.classList.toggle("active", o === next));
        next.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCvMenuOpen(true);
      const prev = opts[Math.max(0, idx - 1)] ?? opts[0];
      if (prev?.dataset.cvTarget) {
        opts.forEach((o) => o.classList.toggle("active", o === prev));
        prev.scrollIntoView({ block: "nearest" });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick =
        els["cv-target-menu"].querySelector<HTMLButtonElement>(".cv-select-option.active:not([hidden])") ??
        opts[0];
      if (pick?.dataset.cvTarget) pickCvTarget(pick.dataset.cvTarget as FindingId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setCvMenuOpen(false);
      cvInput.blur();
    }
  });

  els["cv-target-menu"].addEventListener("mousedown", (e) => {
    // Keep input focus while clicking options
    e.preventDefault();
  });

  els["cv-target-menu"].addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-cv-target]");
    if (!opt?.dataset.cvTarget || opt.hidden) return;
    pickCvTarget(opt.dataset.cvTarget as FindingId);
  });

  document.addEventListener("click", (e) => {
    if (!els["cv-select"].contains(e.target as Node)) setCvMenuOpen(false);
  });

  els["btn-cv"].addEventListener("click", () => cardiovert());

  els["btn-play"].addEventListener("click", () => setPlaying(!state.playing));
  els["btn-reset"].addEventListener("click", () => {
    state.elapsed = 0;
  });
  els["btn-view-reset"].addEventListener("click", () => resetCameraView());
  els["btn-heart"].addEventListener("click", () => {
    state.heartVisible = !state.heartVisible;
    conduction.heartShell.visible = state.heartVisible;
  });
  els["btn-vectors"].addEventListener("click", () => setVectors(!state.vectorsOn));
  els["btn-field"].addEventListener("click", () => setField(!state.fieldOn));

  els["ectopy-site-grid"].addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest("button[data-ectopy-site]");
    if (!chip) return;
    const id = (chip as HTMLElement).dataset.ectopySite as EctopySiteId;
    state.ectopySite = id;
    syncEctopySiteUI();
    if (!state.fieldOn) setField(true);
  });
  els["btn-leads"].addEventListener("click", () => setLeads(!state.leadsOn));

  const onRateChange = (raw: number) => {
    syncRateUI(raw);
  };
  els["rate-slider"].addEventListener("input", () => {
    onRateChange(Number((els["rate-slider"] as HTMLInputElement).value));
  });
  els["rate-input"].addEventListener("input", () => {
    const raw = (els["rate-input"] as HTMLInputElement).value;
    if (raw === "" || raw === "-") return;
    onRateChange(Number(raw));
  });
  els["rate-input"].addEventListener("change", () => {
    onRateChange(Number((els["rate-input"] as HTMLInputElement).value) || 70);
  });

  function syncSpeedUI(pct: number) {
    const clamped = Math.max(0, Math.min(200, Math.round(pct / 5) * 5));
    state.playbackSpeed = clamped / 100;
    (els["speed-slider"] as HTMLInputElement).value = String(clamped);
    (els["speed-input"] as HTMLInputElement).value = String(clamped);
  }

  els["speed-slider"].addEventListener("input", () => {
    syncSpeedUI(Number((els["speed-slider"] as HTMLInputElement).value));
  });
  els["speed-input"].addEventListener("input", () => {
    const raw = (els["speed-input"] as HTMLInputElement).value;
    if (raw === "" || raw === "-") return;
    syncSpeedUI(Number(raw));
  });
  els["speed-input"].addEventListener("change", () => {
    syncSpeedUI(Number((els["speed-input"] as HTMLInputElement).value) || 100);
  });
  syncSpeedUI(100);

  els["btn-block-clear"].addEventListener("click", () => {
    state.customBlocks = [];
    state.customBlockMode = false;
    clearStim();
    holdExpandOpen("bbb");
    if (blocksForFinding(state.finding).length > 0) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-chb-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("chb");
    if (CHB_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-flutter-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("flutter");
    if (FLUTTER_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-pvc-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("pvc");
    if (state.finding === "pvc") setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-pac-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("pac");
    if (state.finding === "pac") setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-vf-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("vf");
    if (VF_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-vt-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("vt");
    if (VT_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-paced-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("paced");
    if (PACED_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-stemi-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("stemi");
    if (STEMI_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-avnrt-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("avnrt");
    if (AVNRT_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  els["btn-avrt-clear"].addEventListener("click", () => {
    clearStim();
    holdExpandOpen("avrt");
    if (AVRT_FINDING_IDS.has(state.finding)) setFinding("nsr");
    else syncFindingUI();
  });

  function setPanelCollapsed(collapsed: boolean) {
    els["panel-shell"].classList.toggle("collapsed", collapsed);
  }

  function togglePanel() {
    setPanelCollapsed(!els["panel-shell"].classList.contains("collapsed"));
  }

  els["btn-collapse"].addEventListener("click", () => setPanelCollapsed(true));
  els["btn-expand"].addEventListener("click", () => setPanelCollapsed(false));

  function syncSegCheckboxes() {
    els["segment-toggles"].querySelectorAll<HTMLInputElement>("input[data-segment]").forEach((input) => {
      const id = input.dataset.segment as SegmentId;
      input.checked = segmentVisibility[id];
    });
  }

  els["segment-toggles"].addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.dataset.segment) return;
    const id = input.dataset.segment as SegmentId;
    // Kent pathways only while an AVRT finding is selected
    if ((id === "accessory" || id === "accessoryR") && !isAvrtFinding(state.finding)) {
      input.checked = false;
      segmentVisibility[id] = false;
      conduction.setSegmentVisibility(id, false);
      return;
    }
    segmentVisibility[id] = input.checked;
    conduction.setSegmentVisibility(id, input.checked);
  });

  els["btn-seg-all"].addEventListener("click", () => {
    for (const g of SEGMENT_META) {
      if (g.id === "myocardiumA" || g.id === "myocardiumV") continue;
      if ((g.id === "accessory" || g.id === "accessoryR") && !isAvrtFinding(state.finding)) {
        segmentVisibility[g.id] = false;
        continue;
      }
      segmentVisibility[g.id] = true;
    }
    applySegmentVisibility();
    syncSegCheckboxes();
  });

  els["btn-seg-none"].addEventListener("click", () => {
    for (const g of SEGMENT_META) {
      if (g.id === "myocardiumA" || g.id === "myocardiumV") continue;
      segmentVisibility[g.id] = false;
    }
    applySegmentVisibility();
    syncSegCheckboxes();
  });

  // Upload
  const splitEditor = createSplitEditor({
    stage: els["upload-split-stage"],
    overlay: els["upload-split-overlay"],
    toolbar: els["upload-split-toolbar"],
    img: els["upload-lightbox-img"] as HTMLImageElement,
  });

  function setUploadBusy(on: boolean, message = "Processing image…") {
    els["upload-busy"].hidden = !on;
    els["upload-busy-text"].textContent = message;
    els["upload-drop"].classList.toggle("is-busy", on);
    els["upload-busy"].setAttribute("aria-busy", on ? "true" : "false");
  }

  function syncUploadPreview(parsed: UploadedEkg) {
    const thumb = els["upload-thumb"] as HTMLImageElement;
    if (parsed.imageUrl) {
      const src = parsed.splitPreviewUrl || parsed.imageUrl;
      thumb.src = src;
      thumb.hidden = false;
      els["upload-thumb-btn"].hidden = false;
      els["upload-split-caption"].hidden = !parsed.splitRegions?.length;
    } else {
      els["upload-thumb-btn"].hidden = true;
      els["upload-split-caption"].hidden = true;
    }
    els["upload-meta"].textContent = `${parsed.name} · ${layoutLabel(parsed.layout)} · ${parsed.availableLeads.length} lead${parsed.availableLeads.length === 1 ? "" : "s"} · ~${parsed.rateBpm} bpm`;
  }

  function mountSplitEditor(parsed: UploadedEkg) {
    const img = els["upload-lightbox-img"] as HTMLImageElement;
    if (parsed.imageUrl && parsed.splitRegions?.length) {
      img.src = parsed.imageUrl;
      const applyBoxes = () => {
        const nw = img.naturalWidth || 1600;
        const nh = img.naturalHeight || 1;
        const w = Math.min(1600, nw);
        const size = parsed.splitImageSize ?? {
          w,
          h: Math.round((nh / nw) * w),
        };
        splitEditor.set(parsed.splitRegions!, size);
        splitEditor.show(true);
      };
      if (img.complete && img.naturalWidth > 0) applyBoxes();
      else img.addEventListener("load", applyBoxes, { once: true });
    } else {
      splitEditor.show(false);
      img.src = parsed.splitPreviewUrl || parsed.imageUrl || img.src;
    }
  }

  async function loadUploadedFile(file: File) {
    const input = els["ekg-file"] as HTMLInputElement;
    const isImage = /\.(png|jpe?g|gif|webp|bmp|tif{1,2})$/i.test(file.name) || file.type.startsWith("image/");
    try {
      setUploadBusy(true, isImage ? "Processing image…" : "Parsing file…");
      els["upload-meta"].textContent = isImage ? "Processing image…" : "Parsing…";
      els["upload-match"].hidden = true;
      els["upload-preview"].hidden = false;
      const thumb = els["upload-thumb"] as HTMLImageElement;
      thumb.hidden = true;
      els["upload-thumb-btn"].hidden = true;
      els["upload-split-caption"].hidden = true;
      // Let the spinner paint before heavy canvas work blocks the main thread
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const parsed = await parseEkgFile(file);
      if (state.upload?.imageUrl) URL.revokeObjectURL(state.upload.imageUrl);
      state.upload = parsed;
      state.stim.armed = false;
      state.stim.site = null;
      stimMarker.visible = false;
      ekg.setCustomSample(null);
      state.elapsed = 0;
      syncUploadPreview(parsed);
      syncRateUI(parsed.rateBpm);
      els["upload-match"].hidden = false;
      els["upload-match"].textContent = "For education only — not a diagnosis";
      setPlaying(true);
      syncFindingUI();
    } catch (err) {
      els["upload-meta"].textContent =
        err instanceof Error ? err.message : "Could not find a 12-lead grid or rhythm strip in this file";
      els["upload-match"].hidden = true;
    } finally {
      setUploadBusy(false);
      input.value = "";
    }
  }

  els["ekg-file"].addEventListener("change", () => {
    const input = els["ekg-file"] as HTMLInputElement;
    const file = input.files?.[0];
    if (file) void loadUploadedFile(file);
  });

  const dropZone = els["upload-drop"];
  let dragDepth = 0;
  const setDropActive = (on: boolean) => dropZone.classList.toggle("is-dragover", on);

  dropZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth += 1;
    setDropActive(true);
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDropActive(true);
  });
  dropZone.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDropActive(false);
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    setDropActive(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void loadUploadedFile(file);
  });

  function downloadText(filename: string, text: string, mime: string) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  els["btn-export-csv"].addEventListener("click", () => {
    if (!state.upload) return;
    const base = state.upload.name.replace(/\.[^.]+$/, "") || "ekg";
    downloadText(`${base}.csv`, exportUploadedCsv(state.upload), "text/csv");
  });

  els["btn-export-xml"].addEventListener("click", () => {
    if (!state.upload) return;
    const base = state.upload.name.replace(/\.[^.]+$/, "") || "ekg";
    downloadText(`${base}.xml`, exportUploadedAecgXml(state.upload), "application/xml");
  });

  function openUploadLightbox() {
    const upload = state.upload;
    if (!upload?.imageUrl && !(els["upload-lightbox-img"] as HTMLImageElement).src) return;
    els["upload-split-hint"].textContent =
      "Drag boxes or resize handles to adjust lead crops, then reprocess. Tall waves can leave the box — extraction will follow them.";
    if (upload) mountSplitEditor(upload);
    els["upload-lightbox"].hidden = false;
    document.body.classList.add("upload-lightbox-open");
    // Boxes need layout after the stage is visible
    requestAnimationFrame(() => splitEditor.paintAll());
  }
  function closeUploadLightbox() {
    els["upload-lightbox"].hidden = true;
    document.body.classList.remove("upload-lightbox-open");
    splitEditor.show(false);
  }

  els["btn-clear-upload"].addEventListener("click", () => {
    if (state.upload?.imageUrl) URL.revokeObjectURL(state.upload.imageUrl);
    state.upload = null;
    setUploadBusy(false);
    els["upload-preview"].hidden = true;
    els["upload-match"].hidden = true;
    els["upload-split-caption"].hidden = true;
    els["upload-thumb-btn"].hidden = true;
    closeUploadLightbox();
    syncFindingUI();
  });

  els["upload-thumb-btn"].addEventListener("click", () => openUploadLightbox());
  els["upload-lightbox-close"].addEventListener("click", () => closeUploadLightbox());
  els["upload-lightbox-x"].addEventListener("click", () => closeUploadLightbox());
  els["upload-split-reprocess"].addEventListener("click", () => {
    void (async () => {
      const upload = state.upload;
      const btn = els["upload-split-reprocess"] as HTMLButtonElement;
      const hint = els["upload-split-hint"];
      if (!upload?.imageUrl) {
        hint.textContent = "No uploaded image to reprocess.";
        return;
      }
      if (!splitEditor.isActive()) {
        hint.textContent = "Lead boxes are not ready yet — wait for the image to load, then try again.";
        return;
      }
      const regions = splitEditor.getRegions();
      if (!regions.length) {
        hint.textContent = "No lead boxes to extract.";
        return;
      }
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = "Reprocessing…";
      hint.textContent = "Re-extracting traces from the adjusted boxes…";
      els["upload-meta"].textContent = "Reprocessing…";
      setUploadBusy(true, "Reprocessing leads…");
      try {
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        const parsed = await reprocessUploadFromRegions(upload, regions);
        state.upload = parsed;
        state.elapsed = 0;
        ekg.setCustomSample(null);
        ekg.setUpload(parsed);
        syncUploadPreview(parsed);
        mountSplitEditor(parsed);
        syncRateUI(parsed.rateBpm);
        els["upload-match"].hidden = false;
        els["upload-match"].textContent = "For education only — not a diagnosis";
        setPlaying(true);
        syncFindingUI();
        btn.textContent = "Reprocessed";
        hint.textContent = `Updated ${parsed.availableLeads.length} leads · ~${parsed.rateBpm} bpm — adjust again anytime.`;
        els["upload-meta"].textContent = `${parsed.name} · ${layoutLabel(parsed.layout)} · ${parsed.availableLeads.length} lead${parsed.availableLeads.length === 1 ? "" : "s"} · ~${parsed.rateBpm} bpm · reprocessed`;
        window.setTimeout(() => {
          if (btn.textContent === "Reprocessed") btn.textContent = prevLabel || "Reprocess";
        }, 1600);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Could not reprocess adjusted boxes";
        els["upload-meta"].textContent = msg;
        hint.textContent = msg;
        btn.textContent = prevLabel || "Reprocess";
      } finally {
        setUploadBusy(false);
        btn.disabled = false;
      }
    })();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els["upload-lightbox"].hidden) closeUploadLightbox();
  });
  window.addEventListener("resize", () => {
    if (!els["upload-lightbox"].hidden && splitEditor.isActive()) splitEditor.paintAll();
  });

  // Hover tooltips — immediate label of conduction structure
  const tooltip = els["seg-tooltip"];
  const tipGroup = tooltip.querySelector(".seg-tooltip-group") as HTMLElement;
  const tipName = tooltip.querySelector(".seg-tooltip-name") as HTMLElement;
  const tipDetail = tooltip.querySelector(".seg-tooltip-detail") as HTMLElement;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hoverMesh: THREE.Mesh | null = null;
  let pointerClient = { x: 0, y: 0 };
  let isDragging = false;

  function clearHoverHighlight() {
    if (!hoverMesh) return;
    hoverMesh.userData.hovered = false;
    const mat = hoverMesh.material;
    if (!(mat instanceof THREE.MeshStandardMaterial)) return;
    if (hoverMesh.userData.isAnatomyGuide) {
      mat.emissiveIntensity = Number(hoverMesh.userData.baseEmissive ?? 0.08);
      mat.opacity = 0.42;
    } else if (hoverMesh.userData.isDeviceLead) {
      mat.emissiveIntensity = Number(hoverMesh.userData.baseEmissive ?? 0.15);
    }
  }

  function clearHover() {
    clearHoverHighlight();
    tooltip.hidden = true;
    hoverMesh = null;
  }

  function showHover(mesh: THREE.Mesh) {
    clearHoverHighlight();
    hoverMesh = mesh;
    mesh.userData.hovered = true;
    if (mesh.userData.isAnatomyGuide) {
      const mat = mesh.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.emissiveIntensity = 0.35;
        mat.opacity = 0.7;
      }
    } else if (mesh.userData.isDeviceLead) {
      const mat = mesh.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.emissiveIntensity = Number(mesh.userData.baseEmissive ?? 0.15) + 0.35;
      }
    }
    const segId = String(mesh.userData.segmentId ?? "");
    if (mesh.userData.isDeviceLead) {
      tipGroup.textContent = "Pacer lead";
      tipGroup.style.color = String(mesh.userData.leadColor ?? "#c8d0d8");
    } else if (mesh.userData.isAnatomyGuide) {
      tipGroup.textContent = "Anatomy";
      tipGroup.style.color = "#8a9aa8";
    } else {
      const group = SEGMENT_META.find((s) => s.id === segId);
      tipGroup.textContent = group?.label ?? "Conduction";
      tipGroup.style.color = group?.color ?? "var(--accent)";
    }
    tipName.textContent = String(mesh.userData.segmentName ?? mesh.name ?? "Pathway");
    tipDetail.textContent = String(mesh.userData.segmentDetail ?? "");
    tooltip.hidden = false;
    positionTooltip();
  }

  function positionTooltip() {
    const pad = 12;
    const tw = tooltip.offsetWidth || 160;
    const th = tooltip.offsetHeight || 40;
    let x = pointerClient.x + pad;
    let y = pointerClient.y + pad;
    if (x + tw > window.innerWidth - 8) x = pointerClient.x - tw - pad;
    if (y + th > window.innerHeight - 8) y = pointerClient.y - th - pad;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }

  function pickSegment(clientX: number, clientY: number): THREE.Mesh | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets: THREE.Object3D[] = [];
    conduction.root.traverse((obj) => {
      if (
        obj instanceof THREE.Mesh &&
        obj.visible &&
        (obj.userData.isConduction || obj.userData.isAnatomyGuide)
      ) {
        targets.push(obj);
      }
    });
    if (deviceLeads.root.visible) {
      deviceLeads.root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh) || !obj.userData.isDeviceLead) return;
        // Lead group may be hidden for the current pacing mode
        if (obj.parent && !obj.parent.visible) return;
        targets.push(obj);
      });
    }
    const hits = raycaster.intersectObjects(targets, false);
    return hits.length ? (hits[0]!.object as THREE.Mesh) : null;
  }

  function pickStimHit(
    clientX: number,
    clientY: number,
  ): { site: StimSite; worldPos: THREE.Vector3 } | null {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const targets: THREE.Object3D[] = [];
    conduction.root.traverse((obj) => {
      if (
        obj instanceof THREE.Mesh &&
        obj.visible &&
        (obj.userData.isConduction || obj.userData.isAnatomyGuide)
      ) {
        targets.push(obj);
      }
    });
    const hits = raycaster.intersectObjects(targets, false);
    const hit = hits[0];
    if (!hit) return null;
    const mesh = hit.object as THREE.Mesh;
    const isGuide = !!mesh.userData.isAnatomyGuide;
    const rawId = mesh.userData.segmentId as SegmentId | "guide" | undefined;
    const name = String(mesh.userData.segmentName ?? mesh.name ?? rawId ?? "site");
    const detail = String(mesh.userData.segmentDetail ?? "");
    const segmentId: SegmentId | undefined = isGuide
      ? stimSegmentForGuide(name)
      : rawId && rawId !== "guide"
        ? rawId
        : undefined;
    if (!segmentId) return null;

    let pathU = hit.uv?.x;
    if (pathU == null || Number.isNaN(pathU)) {
      const curve = mesh.userData.curve as THREE.CatmullRomCurve3 | undefined;
      if (curve) {
        const local = conduction.root.worldToLocal(hit.point.clone());
        let bestU = 0.5;
        let bestD = Infinity;
        for (let i = 0; i <= 40; i++) {
          const u = i / 40;
          const d = curve.getPointAt(u).distanceToSquared(local);
          if (d < bestD) {
            bestD = d;
            bestU = u;
          }
        }
        pathU = bestU;
      } else {
        pathU = isGuide || segmentId === "av" ? 0.5 : 0;
      }
    }

    const site: StimSite = {
      segmentId,
      curveIndex: typeof mesh.userData.curveIndex === "number" ? mesh.userData.curveIndex : undefined,
      pathU,
      name,
      detail,
    };
    return { site, worldPos: hit.point.clone() };
  }

  let stimPointerDown = { x: 0, y: 0, t: 0 };
  renderer.domElement.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    stimPointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (e.button !== 0) return;
    const dx = e.clientX - stimPointerDown.x;
    const dy = e.clientY - stimPointerDown.y;
    if (dx * dx + dy * dy > 36) return; // treat as orbit drag
    if (performance.now() - stimPointerDown.t > 500) return;

    if (state.stim.armed) {
      const picked = pickStimHit(e.clientX, e.clientY);
      if (!picked) return;
      e.preventDefault();
      applyStimSite(picked.site, picked.worldPos);
      return;
    }

    // Click a bundle/fascicle on the model to toggle BBB lesions
    const bbbUiOpen =
      els["bbb-options"].classList.contains("is-open") ||
      state.customBlockMode ||
      BBB_FINDING_IDS.has(state.finding);
    if (!bbbUiOpen || state.upload) return;
    const mesh = pickSegment(e.clientX, e.clientY);
    if (!mesh || mesh.userData.isAnatomyGuide) return;
    const segId = mesh.userData.segmentId as SegmentId | undefined;
    if (!segId || !isBlockableSegment(segId)) return;
    e.preventDefault();
    const next = new Set(activeBundleBlocks());
    if (next.has(segId)) next.delete(segId);
    else next.add(segId);
    const blocks = [...next];
    state.customBlocks = blocks;
    state.customBlockMode = blocks.length > 0;
    state.finding = findingIdForBlocks(blocks);
    if (blocks.length === 0) holdExpandOpen("bbb");
    state.elapsed = 0;
    syncRateUI(getFinding(state.finding).ventRateBpm);
    syncFindingUI();
    if (blocks.length > 0) ensureTeachOverlaysForFinding(state.finding);
  });

  renderer.domElement.addEventListener("pointermove", (e) => {
    pointerClient = { x: e.clientX, y: e.clientY };
    if (isDragging) {
      clearHover();
      return;
    }
    if (!tooltip.hidden) positionTooltip();

    const hit = pickSegment(e.clientX, e.clientY);
    if (hit === hoverMesh) return;
    if (!hit) {
      clearHover();
      return;
    }
    showHover(hit);
  });

  renderer.domElement.addEventListener("pointerleave", () => clearHover());
  controls.addEventListener("start", () => {
    isDragging = true;
    clearHover();
  });
  controls.addEventListener("end", () => {
    isDragging = false;
  });

  function resize() {
    const host = canvasHost;
    const w = Math.max(1, host.clientWidth || window.innerWidth);
    const h = Math.max(1, host.clientHeight || window.innerHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    // Match drawing buffer to the laid-out pane; avoid CSS stretch on iOS
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = `${w}px`;
    renderer.domElement.style.height = `${h}px`;
    ekg.resize();
    if (framingLocked) frameDefaultView();
  }

  function resizeAfterLayout() {
    resize();
    requestAnimationFrame(() => {
      resize();
      requestAnimationFrame(resize);
    });
  }

  // Draggable splitter: stacked only in portrait; landscape stays side-by-side
  const stage = document.querySelector("#stage") as HTMLElement;
  const splitter = document.querySelector("#splitter") as HTMLElement;
  const STACK_MAX_WIDTH = 1200;
  const MIN_PANE = 180;

  function useStackedSplit(): boolean {
    return (
      window.innerWidth <= STACK_MAX_WIDTH &&
      window.matchMedia("(orientation: portrait)").matches
    );
  }

  function applySplit(primaryPx: number) {
    const rect = stage.getBoundingClientRect();
    const splitSize = 6;
    const stacked = useStackedSplit();
    if (stacked) {
      const max = rect.height - splitSize - MIN_PANE;
      const clamped = Math.max(MIN_PANE, Math.min(max, primaryPx));
      stage.style.gridTemplateRows = `${clamped}px ${splitSize}px minmax(0, 1fr)`;
      stage.style.gridTemplateColumns = "1fr";
      splitter.setAttribute("aria-orientation", "horizontal");
    } else {
      const max = rect.width - splitSize - MIN_PANE;
      const clamped = Math.max(MIN_PANE, Math.min(max, primaryPx));
      stage.style.gridTemplateColumns = `${clamped}px ${splitSize}px minmax(0, 1fr)`;
      stage.style.gridTemplateRows = "1fr";
      splitter.setAttribute("aria-orientation", "vertical");
    }
    resize();
  }

  function startSplitDrag(clientPos: number) {
    const rect = stage.getBoundingClientRect();
    const stacked = useStackedSplit();
    const origin = stacked ? rect.top : rect.left;
    document.body.classList.add("is-resizing");

    const onMove = (ev: PointerEvent) => {
      const pos = stacked ? ev.clientY : ev.clientX;
      applySplit(pos - origin);
    };
    const onUp = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    applySplit(clientPos - origin);
  }

  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    splitter.setPointerCapture?.(e.pointerId);
    const stacked = useStackedSplit();
    startSplitDrag(stacked ? e.clientY : e.clientX);
  });

  splitter.addEventListener("keydown", (e) => {
    const stacked = useStackedSplit();
    const rect = stage.getBoundingClientRect();
    const current = stacked
      ? (document.querySelector("#view-3d") as HTMLElement).offsetHeight
      : (document.querySelector("#view-3d") as HTMLElement).offsetWidth;
    const step = e.shiftKey ? 40 : 16;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      applySplit(current - step);
    } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      applySplit(current + step);
    } else if (e.key === "Home") {
      e.preventDefault();
      applySplit(stacked ? rect.height * 0.45 : rect.width / (1 + 1.35));
    }
  });

  window.addEventListener("resize", () => {
    // Drop locked px sizes when orientation / breakpoint flips so CSS defaults apply
    const stacked = useStackedSplit();
    if (stacked) {
      if (stage.style.gridTemplateColumns !== "1fr") {
        stage.style.gridTemplateColumns = "";
        stage.style.gridTemplateRows = "";
      }
    } else if (stage.style.gridTemplateRows && stage.style.gridTemplateRows !== "1fr") {
      stage.style.gridTemplateColumns = "";
      stage.style.gridTemplateRows = "";
    }
    resizeAfterLayout();
  });
  // Phones fire this on rotate even when width stays similar
  window.matchMedia("(orientation: portrait)").addEventListener("change", () => {
    stage.style.gridTemplateColumns = "";
    stage.style.gridTemplateRows = "";
    resizeAfterLayout();
  });
  window.matchMedia(`(max-width: ${STACK_MAX_WIDTH}px)`).addEventListener("change", () => {
    stage.style.gridTemplateColumns = "";
    stage.style.gridTemplateRows = "";
    resizeAfterLayout();
  });
  const viewportRo = new ResizeObserver(() => resize());
  viewportRo.observe(canvasHost);
  resizeAfterLayout();

  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" ||
        t.tagName === "TEXTAREA" ||
        t.tagName === "SELECT" ||
        t.isContentEditable)
    ) {
      return;
    }
    // Splitter owns arrows while focused
    if (t === splitter || splitter.contains(t as Node)) return;

    if (e.code === "Space") {
      e.preventDefault();
      setPlaying(!state.playing);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      if (state.playing) setPlaying(false);
      const windowSec = ekg.getWindowSec();
      const step = e.shiftKey ? windowSec * 0.25 : 0.2; // 1 large box, or ¼ strip
      const delta = e.key === "ArrowRight" ? step : -step;
      state.elapsed = Math.max(0, state.elapsed + delta);
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 5;
      const next = state.ventRateBpm + (e.key === "ArrowUp" ? step : -step);
      onRateChange(next);
    } else if (e.key === "r" || e.key === "R") {
      e.preventDefault();
      resetCameraView();
    } else if (e.key === "v" || e.key === "V") {
      setVectors(!state.vectorsOn);
    } else if (e.key === "f" || e.key === "F") {
      setField(!state.fieldOn);
    } else if (e.key === "l" || e.key === "L") {
      setLeads(!state.leadsOn);
    } else if (e.key === "p" || e.key === "P") {
      e.preventDefault();
      togglePanel();
    }
  });

  let last = performance.now();
  let lastFooterKey = "";
  function animate(now: number) {
    requestAnimationFrame(animate);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (state.playing) {
      let pace = 1;
      if (state.upload) {
        // Paper speed is fixed by durationSec / sampleRate — don't time-warp via rate estimate
        pace = 1;
      }
      // Recovery arc runs in real time; after settle, normal pacing applies
      const cvLive = !!(state.cvRecovery && !state.cvRecovery.settled);
      state.elapsed += dt * (cvLive ? 1 : pace) * (cvLive ? 1 : state.playbackSpeed);
      if (
        state.cvRecovery &&
        !state.cvRecovery.settled &&
        state.elapsed >= state.cvRecovery.shockAtSec + state.cvRecovery.durationSec
      ) {
        finishCardioversionRecovery();
      }
      maybeReleaseCardioversionSampler();
    }

    setMapQrsTiming({
      qrsDurationSec: vectors.getQrsDurationSec(ekg.getCycleSec()),
      cycleSec: ekg.getCycleSec(),
    });
    const { phase, active, mark, tCycle, leads } = ekg.update(state.elapsed);
    const preExPhase =
      isAvrtAntiFinding(state.finding) &&
      !state.upload &&
      (mark === "PR" || (mark === "QRS" && tCycle < 0.38));
    const pvcPhase =
      state.finding === "pvc" &&
      !state.upload &&
      mark === "QRS" &&
      phase.includes("PVC");
    els["phase-chip"].textContent = preExPhase
      ? "Pre-excitation · delta"
      : pvcPhase
        ? "PVC · wall → Purkinje"
        : phase;
    const footerKey = `${mark}|${phase}|${preExPhase}|${pvcPhase}|${state.fieldOn}|${state.leadsOn}`;
    if (footerKey !== lastFooterKey) {
      lastFooterKey = footerKey;
      els["ekg-footer"].innerHTML = preExPhase
        ? `<strong>PR→QRS</strong> · Pre-excitation · delta — Kent → eccentric myocardial field, then His–Purkinje.`
        : pvcPhase
          ? `<strong>QRS</strong> · PVC — myocardial wave from the wall focus, then nearest Purkinje/bundle lights.`
          : `<strong>${mark}</strong> · ${phase} — impulse travels the pathways${state.fieldOn ? " · field on" : ""}${state.leadsOn ? " · leads on" : ""}.`;
    }

    const lit = active.filter((id) => segmentVisibility[id] !== false);
    const stimBranches = state.stim.site && !state.upload ? branchesFromStim(state.stim.site) : undefined;
    const blockBranches =
      !stimBranches && state.customBlockMode && state.customBlocks.length > 0
        ? branchesFromBundleBlocks(state.customBlocks)
        : undefined;
    // BBB preset findings also need the lesion→transseptal branch schedule
    const bbbPresetBranches =
      !stimBranches &&
      !blockBranches &&
      BBB_FINDING_IDS.has(state.finding) &&
      !state.upload
        ? branchesFromBundleBlocks(activeBundleBlocks())
        : undefined;
    const ectopyIdForBranches =
      !state.upload && !state.stim.site
        ? (state.ectopySite ?? defaultEctopySite(state.finding))
        : null;
    const pvcBranches = (() => {
      if (stimBranches || blockBranches || state.finding !== "pvc" || !ectopyIdForBranches) return undefined;
      const chamber = ectopySiteById(ectopyIdForBranches).chamber;
      if (chamber !== "leftVent" && chamber !== "rightVent") return undefined;
      return branchesForPvcSite(chamber, pvcSchedule);
    })();
    const pathBranches = stimBranches ?? blockBranches ?? bbbPresetBranches ?? pvcBranches;
    const blockGating = gatingLesionSegments(activeBundleBlocks());
    const passiveEngage = passiveBlockEngage(tCycle, activeBundleBlocks());
    conduction.setSegmentActive({
      active: lit,
      tCycle,
      finding: state.finding,
      mark,
      branches: pathBranches,
      intensity: 0.95,
      lesionIds: blockGating,
      passiveEngage,
    });
    conduction.updateImpulse({
      tCycle,
      active: lit,
      finding: state.finding,
      mark,
      branches: pathBranches,
      lesionIds: blockGating,
    });
    conduction.updateBlockSitePulse(now / 1000);

    const ectopyId =
      !state.upload && !state.stim.site
        ? (state.ectopySite ?? defaultEctopySite(state.finding))
        : null;
    let ectopyFoci = !state.upload && !state.stim.site
      ? myocardialCaptureFoci(state.finding, ectopyId)
      : [];
    // Multi-beat PVC / PAC strips: lock wave onset to the current ectopic beat
    if ((state.finding === "pvc" || state.finding === "pac") && ectopyFoci.length > 0) {
      const t0 = ectopyBeatT0(state.finding, tCycle, state.finding === "pvc" ? pvcSchedule : null);
      ectopyFoci = ectopyFoci.map((f) => ({ ...f, t0 }));
    }
    const ectopy = ectopyFoci.length > 0 ? ectopyFoci : null;
    const side = avrtKentSide(state.finding);
    const preExcitation =
      isAvrtAntiFinding(state.finding) && side && !state.upload
        ? {
            pos: KENT_VENT_TIP[side],
            color: 0xc070ff,
            t0: 0,
            t1: 0.36,
          }
        : null;

    vectors.update({
      mark,
      active: lit,
      finding: state.finding,
      tCycle,
      cycleSec: ekg.getCycleSec(),
      leads,
      branches: pathBranches,
      fronts: conduction.getActiveFronts({
        tCycle,
        finding: state.finding,
        mark,
        branches: pathBranches,
        lesionIds: blockGating,
      }),
      ectopyFocus: ectopy,
      preExcitation,
      lesionIds: blockGating,
    });

    if (conduction.pulse.visible) {
      const s = 1 + 0.2 * Math.sin(now * 0.014);
      conduction.pulse.scale.setScalar(s);
    }

    controls.update();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(animate);
}

try {
  main();
} catch (err) {
  const app = document.querySelector("#app");
  const msg = err instanceof Error ? err.message : String(err);
  if (app) {
    app.innerHTML = `<div id="boot-error"><strong>EKG View failed to start.</strong><p>Try a hard refresh (Ctrl+Shift+R). If it keeps failing, open the browser console for details.</p><p><code>${msg}</code></p></div>`;
  }
  console.error(err);
}
