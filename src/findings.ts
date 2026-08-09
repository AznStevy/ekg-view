/** Conduction segment IDs lit during animation */
export type SegmentId =
  | "sa"
  | "internodal"
  | "av"
  | "his"
  | "rbb"
  | "lbb"
  | "lbba"
  | "lbbp"
  | "purkinjeR"
  | "purkinjeL"
  | "myocardiumA"
  | "myocardiumV"
  | "accessory"
  | "accessoryR"
  | "flutter"
  | "avnrtSlow"
  | "avnrtFast";

export type FindingCategory =
  | "sinus"
  | "atrial"
  | "svt"
  | "block"
  | "ectopy"
  | "ventricular"
  | "pacing"
  | "pacingFailure"
  | "snd"
  | "ischemia";

export type FindingId =
  | "nsr"
  | "sinusBrady"
  | "sinusTachy"
  | "afib"
  | "aflutterCcw"
  | "aflutterCw"
  | "avnrtTypical"
  | "avnrtAtypical"
  | "avrtOrthoLeft"
  | "avrtOrthoRight"
  | "avrtAntiLeft"
  | "avrtAntiRight"
  | "av1"
  | "av2i"
  | "av2ii"
  | "av21"
  | "av31"
  | "av3"
  | "av3Junctional"
  | "rbbb"
  | "lbbb"
  | "lafb"
  | "lpfb"
  | "rbbbLafb"
  | "rbbbLpfb"
  | "ivcd"
  | "pac"
  | "pvc"
  | "vt"
  | "vtMonoLbbb"
  | "vtMonoRbbb"
  | "vtPoly"
  | "torsades"
  | "vfCoarse"
  | "vfFine"
  | "asystole"
  | "stemiAnt"
  | "stemiInferior"
  | "stemiLateral"
  | "stemiAnterolateral"
  | "stemiPosterior"
  | "stemiAvr"
  | "dewinter"
  | "wellens"
  | "sgarbossa"
  | "pacedAtrial"
  | "pacedVentricular"
  | "pacedDual"
  | "pacedRvSeptal"
  | "pacedRvot"
  | "pacedHis"
  | "pacedLbap"
  | "pacedBiv"
  | "failureToPace"
  | "failureToCapture"
  | "failureToSense"
  | "sinusPause"
  | "saExitBlock"
  | "sickSinus"
  | "tachyBrady";

export type Finding = {
  id: FindingId;
  name: string;
  short: string;
  detail: string;
  category: FindingCategory;
  tags: string[];
  aliases?: string[];
  /** Cycle length in seconds for one displayed beat pattern at ventRateBpm */
  cycleSec: number;
  /** Default ventricular rate for this pattern */
  ventRateBpm: number;
  /** Heart rate label */
  rateLabel: string;
};

export const FINDINGS: Finding[] = [
  {
    id: "nsr",
    name: "Normal sinus rhythm",
    short: "NSR",
    detail: "SA → AV → His → bundles → Purkinje",
    category: "sinus",
    tags: ["sinus", "normal"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "sinusBrady",
    name: "Sinus bradycardia",
    short: "Sinus Brady",
    detail: "Slow SA pacing · long RR · upright P before each QRS",
    category: "sinus",
    tags: ["sinus", "brady"],
    aliases: ["sinus brady"],
    cycleSec: 1.33,
    ventRateBpm: 45,
    rateLabel: "45 bpm",
  },
  {
    id: "sinusTachy",
    name: "Sinus tachycardia",
    short: "Sinus Tach",
    detail: "Fast SA pacing · short RR · P still precedes QRS",
    category: "sinus",
    tags: ["sinus", "tachy"],
    aliases: ["sinus tach"],
    cycleSec: 0.5,
    ventRateBpm: 120,
    rateLabel: "120 bpm",
  },
  {
    id: "afib",
    name: "Atrial fibrillation",
    short: "AFib",
    detail: "No P waves · SA quiescent · LSPV trigger · fibrillatory atria · irregularly irregular QRS",
    category: "atrial",
    tags: ["atrial", "irregular", "pv", "pulmonary veins"],
    aliases: ["af", "atrial fib", "fibrillation", "pulmonary vein"],
    cycleSec: 3.33,
    ventRateBpm: 90,
    rateLabel: "Irregular",
  },
  {
    id: "aflutterCcw",
    name: "Atrial flutter · CCW (typical)",
    short: "Flutter CCW",
    detail: "CTI macro-reentry · counterclockwise · inferior − sawtooth · V1 often +",
    category: "atrial",
    tags: ["atrial", "reentry", "flutter", "cti", "ccw"],
    aliases: ["aflutter", "flutter", "typical flutter", "counterclockwise", "cti", "negative sawtooth"],
    cycleSec: 0.8,
    ventRateBpm: 150,
    rateLabel: "Inf − saw",
  },
  {
    id: "aflutterCw",
    name: "Atrial flutter · CW (reverse typical)",
    short: "Flutter CW",
    detail: "CTI macro-reentry · clockwise · inferior + F · V1 often −",
    category: "atrial",
    tags: ["atrial", "reentry", "flutter", "cti", "cw"],
    aliases: ["clockwise flutter", "reverse typical", "atypical cti", "positive flutter"],
    cycleSec: 0.8,
    ventRateBpm: 150,
    rateLabel: "Inf + F",
  },
  {
    id: "avnrtTypical",
    name: "Typical AVNRT (slow–fast)",
    short: "Typical",
    detail: "Anterograde slow · retrograde fast · narrow QRS · RP≪PR · pseudo-r′ V1 / P-on-T",
    category: "svt",
    tags: ["svt", "reentry", "avnrt", "narrow", "nodal", "typical", "slow-fast"],
    aliases: ["avnrt", "typical avnrt", "slow fast", "svt", "psvt", "av nodal reentry"],
    cycleSec: 0.33,
    ventRateBpm: 180,
    rateLabel: "180 bpm",
  },
  {
    id: "avnrtAtypical",
    name: "Atypical AVNRT (fast–slow)",
    short: "Atypical",
    detail: "Anterograde fast · retrograde slow · long RP · inverted P before next QRS",
    category: "svt",
    tags: ["svt", "reentry", "avnrt", "narrow", "nodal", "atypical", "fast-slow"],
    aliases: ["atypical avnrt", "fast slow", "long rp avnrt", "uncommon avnrt"],
    cycleSec: 0.38,
    ventRateBpm: 160,
    rateLabel: "160 bpm",
  },
  {
    id: "avrtOrthoLeft",
    name: "Orthodromic AVRT · left Kent",
    short: "Ortho L",
    detail: "Down AV/His–Purkinje · up left Kent · narrow QRS · long RP",
    category: "svt",
    tags: ["svt", "reentry", "avrt", "orthodromic", "accessory", "left", "narrow"],
    aliases: ["orthodromic left", "ortho avrt left", "left kent ortho"],
    cycleSec: 0.28,
    ventRateBpm: 214,
    rateLabel: "214 bpm",
  },
  {
    id: "avrtOrthoRight",
    name: "Orthodromic AVRT · right Kent",
    short: "Ortho R",
    detail: "Down AV/His–Purkinje · up right Kent · narrow QRS · long RP",
    category: "svt",
    tags: ["svt", "reentry", "avrt", "orthodromic", "accessory", "right", "narrow"],
    aliases: ["orthodromic right", "ortho avrt right", "right kent ortho"],
    cycleSec: 0.28,
    ventRateBpm: 214,
    rateLabel: "214 bpm",
  },
  {
    id: "avrtAntiLeft",
    name: "Antidromic AVRT · left Kent",
    short: "Anti L",
    detail: "Down left Kent · up His/AV · wide preexcited QRS · VT mimic",
    category: "svt",
    tags: ["svt", "reentry", "avrt", "antidromic", "accessory", "left", "wide", "preexcitation", "delta"],
    aliases: ["antidromic left", "anti avrt left", "left kent anti", "wpw", "wolff parkinson white"],
    cycleSec: 0.27,
    ventRateBpm: 222,
    rateLabel: "222 bpm",
  },
  {
    id: "avrtAntiRight",
    name: "Antidromic AVRT · right Kent",
    short: "Anti R",
    detail: "Down right Kent · up His/AV · wide preexcited QRS · VT mimic",
    category: "svt",
    tags: ["svt", "reentry", "avrt", "antidromic", "accessory", "right", "wide", "preexcitation", "delta"],
    aliases: ["antidromic right", "anti avrt right", "right kent anti"],
    cycleSec: 0.27,
    ventRateBpm: 222,
    rateLabel: "222 bpm",
  },
  {
    id: "av1",
    name: "1° AV block",
    short: "1° AVB",
    detail: "PR > 200 ms (1 large square) · every P conducts",
    category: "block",
    tags: ["av", "block", "pr"],
    aliases: ["first degree", "prolonged pr"],
    cycleSec: 0.95,
    ventRateBpm: 63,
    rateLabel: "63 bpm",
  },
  {
    id: "av2i",
    name: "2° AV block Mobitz I",
    short: "Wenckebach",
    detail: "AV-nodal block · progressive PR prolongation before dropped QRS",
    category: "block",
    tags: ["av", "block", "wenckebach", "supra-his"],
    aliases: ["mobitz 1", "mobitz i", "type 1"],
    /** 4:3 group · atrial ~75 · 3 QRS / 3.2 s ≈ 56 bpm */
    cycleSec: 3.2,
    ventRateBpm: 56,
    rateLabel: "56 bpm",
  },
  {
    id: "av2ii",
    name: "2° AV block Mobitz II",
    short: "Mobitz II",
    detail: "Infra-His block · constant PR · sudden drop (no progressive PR lengthening)",
    category: "block",
    tags: ["av", "block", "infra-his"],
    aliases: ["mobitz 2", "mobitz ii", "type 2", "hay block"],
    /** 3:2 · atrial ~71 · constant PR 180 ms · 2 QRS / 2.52 s ≈ 48 bpm */
    cycleSec: 2.52,
    ventRateBpm: 48,
    rateLabel: "48 bpm",
  },
  {
    id: "av21",
    name: "2:1 AV block",
    short: "2:1",
    detail: "Fixed 2:1 · constant PR · two P waves per QRS",
    category: "block",
    tags: ["av", "block", "fixed-ratio", "2:1"],
    aliases: ["2 to 1", "two to one", "fixed ratio"],
    cycleSec: 1.6,
    ventRateBpm: 38,
    rateLabel: "38 bpm",
  },
  {
    id: "av31",
    name: "High-grade AV block · 3:1",
    short: "3:1",
    detail: "High-grade 2° · fixed 3:1 · constant PR · very slow ventricular rate",
    category: "block",
    tags: ["av", "block", "fixed-ratio", "3:1", "high-grade"],
    aliases: ["3 to 1", "high grade", "high-grade"],
    cycleSec: 2.4,
    ventRateBpm: 25,
    rateLabel: "25 bpm",
  },
  {
    id: "av3Junctional",
    name: "3° AV block · junctional escape",
    short: "CHB junct",
    detail: "Complete block · AV dissociation · narrow QRS escape from His/AV junction",
    category: "block",
    tags: ["av", "block", "dissociation", "junctional", "escape"],
    aliases: ["junctional escape", "nodal escape", "narrow escape"],
    cycleSec: 2.67,
    ventRateBpm: 45,
    rateLabel: "45 bpm",
  },
  {
    id: "av3",
    name: "3° AV block · ventricular escape",
    short: "CHB vent",
    detail: "Complete block · AV dissociation · wide QRS escape from ventricular focus",
    category: "block",
    tags: ["av", "block", "dissociation", "ventricular", "escape"],
    aliases: ["complete heart block", "third degree", "chb", "ventricular escape"],
    cycleSec: 3.33,
    ventRateBpm: 36,
    rateLabel: "36 bpm",
  },
  {
    id: "rbbb",
    name: "Right bundle branch block",
    short: "RBBB",
    detail: "QRS >120 ms · rsR′ (“M”) V1–V3 · wide slurred S in I, aVL, V5–V6",
    category: "block",
    tags: ["bundle", "wide qrs", "rbb"],
    aliases: ["right bundle"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "lbbb",
    name: "Left bundle branch block",
    short: "LBBB",
    detail: "QRS >120 ms · dominant S (“W”) V1 · broad notched R (“M”) V6",
    category: "block",
    tags: ["bundle", "wide qrs", "lbb"],
    aliases: ["left bundle"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "lafb",
    name: "Left anterior fascicular block",
    short: "LAFB",
    detail: "LAD · qR I/aVL · rS II/III/aVF · R-peak aVL >45 ms",
    category: "block",
    tags: ["fascicle", "hemiblock", "laf", "axis"],
    aliases: ["left anterior hemiblock", "lahb", "lafb"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "lpfb",
    name: "Left posterior fascicular block",
    short: "LPFB",
    detail: "RAD · rS I/aVL · qR II/III/aVF · R-peak aVF >45 ms (rare alone)",
    category: "block",
    tags: ["fascicle", "hemiblock", "lpf", "axis"],
    aliases: ["left posterior hemiblock", "lphb", "lpfb"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "rbbbLafb",
    name: "Bifascicular block · RBBB + LAFB",
    short: "RBBB+LAFB",
    detail: "RBBB + LAFB · rsR′ V1 with left axis (qR I/aVL · rS inferior)",
    category: "block",
    tags: ["bundle", "fascicle", "bifascicular"],
    aliases: ["bifascicular", "rbbb lafb"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "rbbbLpfb",
    name: "Bifascicular block · RBBB + LPFB",
    short: "RBBB+LPFB",
    detail: "RBBB + LPFB · rsR′ V1 with right axis (rS I/aVL · qR inferior)",
    category: "block",
    tags: ["bundle", "fascicle", "bifascicular"],
    aliases: ["rbbb lpfb"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "ivcd",
    name: "Nonspecific IVCD",
    short: "IVCD",
    detail: "QRS >100 ms · not LBBB or RBBB morphology",
    category: "block",
    tags: ["bundle", "wide qrs", "ivcd", "nonspecific"],
    aliases: ["intraventricular conduction delay", "nonspecific ivcd", "ivcd"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "pac",
    name: "Premature atrial complex",
    short: "PAC",
    detail: "Early ectopic P′ · usually conducts · incomplete compensatory pause",
    category: "ectopy",
    tags: ["ectopy", "atrial", "pac"],
    aliases: ["apc", "atrial ectopic", "atrial premature", "pjc"],
    cycleSec: 7.0,
    ventRateBpm: 60,
    rateLabel: "PAC",
  },
  {
    id: "pvc",
    name: "Premature ventricular complex",
    short: "PVC",
    detail: "Wall focus · myocardial wave → Purkinje · wide QRS · full compensatory pause",
    category: "ectopy",
    tags: ["ectopy", "ventricular"],
    aliases: ["vpc", "ventricular ectopic"],
    cycleSec: 7.0,
    ventRateBpm: 60,
    rateLabel: "PVC",
  },
  {
    id: "vt",
    name: "Monomorphic VT",
    short: "VT",
    detail: "Regular wide-complex tachycardia · identical QRS each beat",
    category: "ventricular",
    tags: ["vt", "wide complex", "monomorphic"],
    aliases: ["ventricular tachycardia", "mono vt"],
    cycleSec: 0.4,
    ventRateBpm: 150,
    rateLabel: "150 bpm",
  },
  {
    id: "vtMonoLbbb",
    name: "Monomorphic VT · LBBB morphology",
    short: "VT-LBBB",
    detail: "Wide LBBB-like QRS · negative V1 · often RV/outflow origin",
    category: "ventricular",
    tags: ["vt", "monomorphic", "lbbb"],
    aliases: ["rvot", "outflow vt", "lbbb vt"],
    cycleSec: 0.4,
    ventRateBpm: 160,
    rateLabel: "160 bpm",
  },
  {
    id: "vtMonoRbbb",
    name: "Monomorphic VT · RBBB morphology",
    short: "VT-RBBB",
    detail: "Wide RBBB-like QRS · positive V1 · often LV origin",
    category: "ventricular",
    tags: ["vt", "monomorphic", "rbbb"],
    aliases: ["lv vt", "rbbb vt"],
    cycleSec: 0.4,
    ventRateBpm: 160,
    rateLabel: "160 bpm",
  },
  {
    id: "vtPoly",
    name: "Polymorphic VT",
    short: "Poly VT",
    detail: "Beat-to-beat changing QRS morphology · unstable axis",
    category: "ventricular",
    tags: ["vt", "polymorphic"],
    aliases: ["polymorphic ventricular tachycardia"],
    /** Six wide QRS in one pattern window → 180 bpm when ventRateBpm matches */
    cycleSec: 2.0,
    ventRateBpm: 180,
    rateLabel: "180 bpm",
  },
  {
    id: "torsades",
    name: "Torsades de pointes",
    short: "TdP",
    detail: "Long QT → pause · polymorphic VT twisting around baseline",
    category: "ventricular",
    tags: ["vt", "polymorphic", "long qt", "torsades"],
    aliases: ["torsade", "tdp", "twisting", "torsades de pointes"],
    cycleSec: 5.0,
    ventRateBpm: 160,
    rateLabel: "Twisting",
  },
  {
    id: "vfCoarse",
    name: "Ventricular fibrillation · coarse",
    short: "VF coarse",
    detail: "Large chaotic undulations · no discrete QRS · no pulse",
    category: "ventricular",
    tags: ["vf", "arrest", "coarse"],
    aliases: ["vf", "ventricular fib", "fib", "coarse vf"],
    cycleSec: 4.5,
    ventRateBpm: 200,
    rateLabel: "Coarse",
  },
  {
    id: "vfFine",
    name: "Ventricular fibrillation · fine",
    short: "VF fine",
    detail: "Low-amplitude chaotic undulations · no QRS · no pulse",
    category: "ventricular",
    tags: ["vf", "arrest", "fine"],
    aliases: ["fine vf", "fine ventricular fib"],
    cycleSec: 4.5,
    ventRateBpm: 200,
    rateLabel: "Fine",
  },
  {
    id: "asystole",
    name: "Asystole",
    short: "Asystole",
    detail: "No atrial or ventricular depolarization · flatline · confirm in multiple leads",
    category: "ventricular",
    tags: ["arrest", "asystole", "flatline", "pea"],
    aliases: ["flatline", "cardiac arrest", "standstill"],
    cycleSec: 2.0,
    ventRateBpm: 30,
    rateLabel: "None",
  },
  {
    id: "stemiAnt",
    name: "Anterior STEMI",
    short: "Anterior",
    detail: "ST elevation V1–V4 · reciprocal inferior depression · LAD",
    category: "ischemia",
    tags: ["stemi", "mi", "injury", "lad", "anterior"],
    aliases: ["anterior mi", "lad", "st elevation", "stemi"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "stemiInferior",
    name: "Inferior STEMI",
    short: "Inferior",
    detail: "ST elevation II · III · aVF · reciprocal I/aVL · often RCA",
    category: "ischemia",
    tags: ["stemi", "mi", "injury", "inferior", "rca"],
    aliases: ["inferior mi", "rca stemi"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "stemiLateral",
    name: "Lateral STEMI",
    short: "Lateral",
    detail: "ST elevation I · aVL · V5–V6 · reciprocal inferior",
    category: "ischemia",
    tags: ["stemi", "mi", "injury", "lateral", "lcx"],
    aliases: ["lateral mi", "lcx stemi"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "stemiAnterolateral",
    name: "Anterolateral STEMI",
    short: "Ant-lat",
    detail: "ST elevation V2–V6 · I · aVL · extensive LAD / diagonal",
    category: "ischemia",
    tags: ["stemi", "mi", "injury", "anterolateral", "lad"],
    aliases: ["anterolateral mi", "extensive anterior"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "stemiPosterior",
    name: "Posterior MI",
    short: "Posterior",
    detail: "Tall R V1–V2 · horizontal STD V1–V3 · upright T · posterior STE equivalent",
    category: "ischemia",
    tags: ["stemi", "mi", "posterior", "equivalent"],
    aliases: ["posterior mi", "posterior stemi", "inferoposterior"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "stemiAvr",
    name: "aVR STE · LMCA / proximal equivalent",
    short: "aVR STE",
    detail: "ST elevation aVR · diffuse STD · left main / severe 3VD cue",
    category: "ischemia",
    tags: ["stemi", "equivalent", "avr", "lmca"],
    aliases: ["lmca", "left main", "avr elevation", "stemi equivalent"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "dewinter",
    name: "De Winter T waves",
    short: "De Winter",
    detail: "Upsloping STD + hyperacute peaked T V2–V4 · LAD equivalent",
    category: "ischemia",
    tags: ["stemi", "equivalent", "dewinter", "lad"],
    aliases: ["dewinter", "de winter", "de winters"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "wellens",
    name: "Wellens syndrome",
    short: "Wellens",
    detail: "Deep / biphasic T V2–V3 · isoelectric ST · critical proximal LAD",
    category: "ischemia",
    tags: ["stemi", "equivalent", "wellens", "lad"],
    aliases: ["wellens", "wellens waves", "wellens syndrome"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "sgarbossa",
    name: "Sgarbossa · STEMI with LBBB",
    short: "Sgarbossa",
    detail: "LBBB + concordant STE (I/aVL/V5–V6) · excessive discordant STE V1–V3",
    category: "ischemia",
    tags: ["stemi", "equivalent", "sgarbossa", "lbbb"],
    aliases: ["sgarbossa", "sgarbossa criteria", "smith modified"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
  },
  {
    id: "pacedAtrial",
    name: "Atrial paced · AAI",
    short: "AAI",
    detail: "Single-chamber RA lead · spike → P → conducted narrow QRS",
    category: "pacing",
    tags: ["pacemaker", "atrial", "aai", "spike", "single"],
    aliases: ["atrial pacing", "a paced"],
    cycleSec: 0.9,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedVentricular",
    name: "VVI · RV apical",
    short: "VVI",
    detail: "Single-chamber RV apical lead · spike → wide LBBB-like QRS",
    category: "pacing",
    tags: ["pacemaker", "ventricular", "vvi", "spike", "single", "rv"],
    aliases: ["ventricular pacing", "v paced", "rv paced", "rv apical"],
    cycleSec: 0.9,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedDual",
    name: "DDD · dual chamber",
    short: "DDD",
    detail: "RA + RV apical leads · A spike → P · V spike → wide QRS",
    category: "pacing",
    tags: ["pacemaker", "dual", "ddd", "av sequential", "spike"],
    aliases: ["av paced", "dual chamber", "dddr"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedRvSeptal",
    name: "DDD · RV septal",
    short: "RVs",
    detail: "RA + mid-RV septal lead · myocardial capture · moderately wide QRS",
    category: "pacing",
    tags: ["pacemaker", "dual", "rv", "septal", "spike"],
    aliases: ["rv septal pacing", "septal pace"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedRvot",
    name: "DDD · RVOT",
    short: "RVOT",
    detail: "RA + RV outflow lead · myocardial capture · inferior-axis paced QRS",
    category: "pacing",
    tags: ["pacemaker", "dual", "rvot", "outflow", "spike"],
    aliases: ["rvot pacing", "outflow pace"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedHis",
    name: "DDD · His-bundle",
    short: "His",
    detail: "RA + His lead · conduction-system capture · near-physiologic QRS",
    category: "pacing",
    tags: ["pacemaker", "dual", "his", "csp", "conduction system"],
    aliases: ["his bundle pacing", "hbp", "selective his"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedLbap",
    name: "DDD · LBAP",
    short: "LBAP",
    detail: "RA + left bundle area pacing · narrower / physiologic QRS",
    category: "pacing",
    tags: ["pacemaker", "dual", "lbap", "csp", "conduction system"],
    aliases: ["left bundle area", "lbbap", "csp"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedBiv",
    name: "BiV · CRT",
    short: "BiV",
    detail: "RA + RV + LV (CS) leads · biventricular capture · fusion QRS",
    category: "pacing",
    tags: ["pacemaker", "biv", "crt", "triple", "cs lead"],
    aliases: ["biventricular", "crt", "cardiac resynchronization"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "failureToPace",
    name: "Failure to pace (output failure)",
    short: "No pace",
    detail: "Expected pacing window with no spike · pause → escape · pick device mode for leads",
    category: "pacingFailure",
    tags: ["pacemaker", "failure", "output"],
    aliases: ["output failure", "failure to output"],
    cycleSec: 2.4,
    ventRateBpm: 40,
    rateLabel: "Pause",
  },
  {
    id: "failureToCapture",
    name: "Failure to capture",
    short: "No capt.",
    detail: "Pacing spikes present · no myocardial capture · pick device mode for leads",
    category: "pacingFailure",
    tags: ["pacemaker", "failure", "capture"],
    aliases: ["noncapture", "loss of capture"],
    cycleSec: 2.2,
    ventRateBpm: 45,
    rateLabel: "Spikes",
  },
  {
    id: "failureToSense",
    name: "Failure to sense (undersensing)",
    short: "Undersense",
    detail: "Intrinsic QRS ignored · competing spikes · pick device mode for leads",
    category: "pacingFailure",
    tags: ["pacemaker", "failure", "sensing"],
    aliases: ["undersensing", "undersense"],
    cycleSec: 2.0,
    ventRateBpm: 55,
    rateLabel: "Compete",
  },
  {
    id: "sinusPause",
    name: "Sinus pause / arrest",
    short: "Pause",
    detail: "Sudden absence of P waves · pause not a multiple of PP",
    category: "snd",
    tags: ["sinus", "pause", "snd"],
    aliases: ["sinus arrest", "atrial pause"],
    cycleSec: 3.0,
    ventRateBpm: 40,
    rateLabel: "Pause",
  },
  {
    id: "saExitBlock",
    name: "SA exit block (type II)",
    short: "SA block",
    detail: "Dropped P–QRS · pause ≈ 2× the basic PP interval",
    category: "snd",
    tags: ["sinus", "exit block", "snd"],
    aliases: ["sinoatrial block", "sa block"],
    cycleSec: 3.2,
    ventRateBpm: 45,
    rateLabel: "2× PP",
  },
  {
    id: "sickSinus",
    name: "Sick sinus syndrome",
    short: "SSS",
    detail: "Sinus brady · sinus arrest · junctional escape (SND)",
    category: "snd",
    tags: ["sinus", "snd", "brady", "sss", "sick sinus"],
    aliases: ["sick sinus syndrome", "sss", "sinus node dysfunction", "snd"],
    cycleSec: 3.2,
    ventRateBpm: 38,
    rateLabel: "Brady+pause",
  },
  {
    id: "tachyBrady",
    name: "Tachy–brady syndrome",
    short: "TachyBrady",
    detail: "Burst of atrial tachyarrhythmia → long sinus pause",
    category: "snd",
    tags: ["sinus", "snd", "afib", "pause"],
    aliases: ["tachycardia bradycardia", "tachy brady"],
    cycleSec: 3.2,
    ventRateBpm: 55,
    rateLabel: "Burst→pause",
  },
];

/** Pattern duration at a chosen ventricular rate */
export function cycleSecForRate(finding: Finding, ventRateBpm: number): number {
  const rate = Math.max(20, Math.min(320, ventRateBpm));
  return finding.cycleSec * (finding.ventRateBpm / rate);
}

export function getFinding(id: FindingId): Finding {
  const f = FINDINGS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown finding: ${id}`);
  return f;
}

export function findingSearchText(f: Finding): string {
  return [f.id, f.name, f.short, f.detail, f.category, ...(f.tags ?? []), ...(f.aliases ?? [])]
    .join(" ")
    .toLowerCase();
}

export function findingMatchesQuery(f: Finding, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = findingSearchText(f);
  return q.split(/\s+/).every((token) => hay.includes(token));
}

export function isAvnrtFinding(id: FindingId | string | undefined): boolean {
  return id === "avnrtTypical" || id === "avnrtAtypical";
}

export function isAvrtFinding(id: FindingId | string | undefined): boolean {
  return (
    id === "avrtOrthoLeft" ||
    id === "avrtOrthoRight" ||
    id === "avrtAntiLeft" ||
    id === "avrtAntiRight"
  );
}

export function isAvrtOrthoFinding(id: FindingId | string | undefined): boolean {
  return id === "avrtOrthoLeft" || id === "avrtOrthoRight";
}

export function isAvrtAntiFinding(id: FindingId | string | undefined): boolean {
  return id === "avrtAntiLeft" || id === "avrtAntiRight";
}

export function avrtKentSide(id: FindingId | string | undefined): "left" | "right" | null {
  if (id === "avrtOrthoLeft" || id === "avrtAntiLeft") return "left";
  if (id === "avrtOrthoRight" || id === "avrtAntiRight") return "right";
  return null;
}
