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
  | "flutter"
  | "avnrtSlow"
  | "avnrtFast";

export type FindingCategory =
  | "rhythm"
  | "block"
  | "bbb"
  | "ectopy"
  | "vt"
  | "paced"
  | "snd"
  | "preexcitation"
  | "ischemia";

export type FindingId =
  | "nsr"
  | "sinusBrady"
  | "sinusTachy"
  | "afib"
  | "aflutterCcw"
  | "aflutterCw"
  | "avnrt"
  | "av1"
  | "av2i"
  | "av2ii"
  | "av3"
  | "av3Junctional"
  | "rbbb"
  | "lbbb"
  | "lafb"
  | "lpfb"
  | "rbbbLafb"
  | "rbbbLpfb"
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
  | "wpw"
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
    category: "rhythm",
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
    category: "rhythm",
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
    category: "rhythm",
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
    detail: "No P waves · SA quiescent · fibrillatory atria · irregularly irregular QRS",
    category: "rhythm",
    tags: ["atrial", "irregular"],
    aliases: ["af", "atrial fib", "fibrillation"],
    cycleSec: 3.33,
    ventRateBpm: 90,
    rateLabel: "Irregular",
  },
  {
    id: "aflutterCcw",
    name: "Atrial flutter · CCW (typical)",
    short: "Flutter CCW",
    detail: "CTI macro-reentry · counterclockwise · inferior − sawtooth · V1 often +",
    category: "rhythm",
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
    category: "rhythm",
    tags: ["atrial", "reentry", "flutter", "cti", "cw"],
    aliases: ["clockwise flutter", "reverse typical", "atypical cti", "positive flutter"],
    cycleSec: 0.8,
    ventRateBpm: 150,
    rateLabel: "Inf + F",
  },
  {
    id: "avnrt",
    name: "AVNRT (AV-nodal reentrant tachycardia)",
    short: "AVNRT",
    detail: "Dual AV-node pathways · typical slow–fast · narrow QRS · RP≪PR · pseudo-r′ V1",
    category: "rhythm",
    tags: ["svt", "reentry", "avnrt", "narrow", "nodal"],
    aliases: ["avnrt", "svt", "psvt", "av nodal reentry", "slow fast"],
    cycleSec: 0.33,
    ventRateBpm: 180,
    rateLabel: "180 bpm",
  },
  {
    id: "av1",
    name: "1° AV block",
    short: "1° AVB",
    detail: "PR > 200 ms · every P conducts",
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
    detail: "AV-nodal block · progressive PR → dropped QRS",
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
    detail: "Infra-His block · constant PR · sudden drop",
    category: "block",
    tags: ["av", "block", "infra-his"],
    aliases: ["mobitz 2", "mobitz ii", "type 2"],
    /** 3:2 · atrial ~71 · constant PR 180 ms · 2 QRS / 2.52 s ≈ 48 bpm */
    cycleSec: 2.52,
    ventRateBpm: 48,
    rateLabel: "48 bpm",
  },
  {
    id: "av3Junctional",
    name: "3° AV block · junctional escape",
    short: "CHB junct",
    detail: "Complete block · narrow QRS escape from His/AV junction",
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
    detail: "Complete block · wide QRS escape from ventricular focus",
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
    detail: "Block in RBB · LBB first → delayed RV · rsR′ in V1–V2 · wide S in I/V6",
    category: "bbb",
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
    detail: "Block in LBB · RBB first → transseptal distal left · broad R in I/V6",
    category: "bbb",
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
    detail: "Block in LAF · left axis · qR in I/aVL · rS in II/III/aVF",
    category: "bbb",
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
    detail: "Block in LPF · right axis · rS in I/aVL · qR inferior (rare alone)",
    category: "bbb",
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
    detail: "Block in RBB + LAF · RBBB morphology + left axis",
    category: "bbb",
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
    detail: "Block in RBB + LPF · RBBB morphology + right axis",
    category: "bbb",
    tags: ["bundle", "fascicle", "bifascicular"],
    aliases: ["rbbb lpfb"],
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
    detail: "Early wide QRS · no preceding P · full compensatory pause",
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
    category: "vt",
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
    category: "vt",
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
    category: "vt",
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
    category: "vt",
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
    category: "vt",
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
    category: "vt",
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
    category: "vt",
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
    category: "vt",
    tags: ["arrest", "asystole", "flatline", "pea"],
    aliases: ["flatline", "cardiac arrest", "standstill"],
    cycleSec: 2.0,
    ventRateBpm: 30,
    rateLabel: "None",
  },
  {
    id: "wpw",
    name: "WPW pattern",
    short: "WPW",
    detail: "Short PR · delta wave · wide fusion QRS",
    category: "preexcitation",
    tags: ["accessory", "preexcitation", "delta"],
    aliases: ["wolff parkinson white", "preexcitation"],
    cycleSec: 0.86,
    ventRateBpm: 70,
    rateLabel: "70 bpm",
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
    category: "paced",
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
    category: "paced",
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
    category: "paced",
    tags: ["pacemaker", "dual", "ddd", "av sequential", "spike"],
    aliases: ["av paced", "dual chamber", "dddr"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedLbap",
    name: "DDD · LBAP",
    short: "LBAP",
    detail: "RA + left bundle area pacing · narrower / physiologic QRS",
    category: "paced",
    tags: ["pacemaker", "dual", "lbap", "csp", "conduction system"],
    aliases: ["left bundle area", "lbbap", "csp", "his bundle pacing"],
    cycleSec: 0.95,
    ventRateBpm: 60,
    rateLabel: "60 bpm",
  },
  {
    id: "pacedBiv",
    name: "BiV · CRT",
    short: "BiV",
    detail: "RA + RV + LV (CS) leads · biventricular capture · fusion QRS",
    category: "paced",
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
    detail: "Expected pacing window with no spike · pause → escape",
    category: "paced",
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
    detail: "Pacing spikes present · no myocardial capture after spike",
    category: "paced",
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
    detail: "Intrinsic QRS ignored · pacing spike falls inappropriately",
    category: "paced",
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
  const rate = Math.max(20, Math.min(250, ventRateBpm));
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
