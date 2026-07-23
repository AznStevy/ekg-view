import type { FindingId, SegmentId } from "./findings";
import type { CycleMark, LeadId, WaveSample } from "./ekgWaveforms";
import { LEADS } from "./ekgWaveforms";

/** How the uploaded recording should be shown */
export type UploadLayout = "full12" | "limb6" | "precordial6" | "telemetry" | "rhythm" | "partial";

export type UploadedEkg = {
  name: string;
  /** Preview image when source was a raster; otherwise null */
  imageUrl: string | null;
  /** Primary / rhythm channel (prefer II) */
  signal: Float32Array;
  /** Per-lead samples when available (same length as signal or resampled) */
  leadSignals: Partial<Record<LeadId, Float32Array>>;
  /** Leads present in the recording */
  availableLeads: LeadId[];
  /** Optional original channel labels (e.g. MLII, V5) for display */
  leadLabels?: Partial<Record<LeadId, string>>;
  layout: UploadLayout;
  durationSec: number;
  rateBpm: number;
  rPeaks: number[];
  /** Hz when known (PhysioNet / digital files) */
  sampleRateHz?: number;
  sourceKind: "image" | "csv" | "json" | "xml" | "text";
};

function emptyLeads(): Record<LeadId, number> {
  return {
    I: 0,
    II: 0,
    III: 0,
    aVR: 0,
    aVL: 0,
    aVF: 0,
    V1: 0,
    V2: 0,
    V3: 0,
    V4: 0,
    V5: 0,
    V6: 0,
  };
}

const LEAD_W: Partial<Record<LeadId, number>> = {
  I: 0.7,
  II: 1,
  III: 0.45,
  aVR: -0.75,
  aVL: 0.3,
  aVF: 0.75,
  V1: -0.4,
  V2: -0.15,
  V3: 0.35,
  V4: 0.95,
  V5: 1.05,
  V6: 0.95,
};

const LEAD_ALIASES: Record<string, LeadId> = {
  i: "I",
  ii: "II",
  iii: "III",
  avr: "aVR",
  avl: "aVL",
  avf: "aVF",
  v1: "V1",
  v2: "V2",
  v3: "V3",
  v4: "V4",
  v5: "V5",
  v6: "V6",
  "lead i": "I",
  "lead ii": "II",
  "lead iii": "III",
  "lead avr": "aVR",
  "lead avl": "aVL",
  "lead avf": "aVF",
  "lead v1": "V1",
  "lead v2": "V2",
  "lead v3": "V3",
  "lead v4": "V4",
  "lead v5": "V5",
  "lead v6": "V6",
  mdc_ecg_lead_i: "I",
  mdc_ecg_lead_ii: "II",
  mdc_ecg_lead_iii: "III",
  mdc_ecg_lead_avr: "aVR",
  mdc_ecg_lead_avl: "aVL",
  mdc_ecg_lead_avf: "aVF",
  mdc_ecg_lead_v1: "V1",
  mdc_ecg_lead_v2: "V2",
  mdc_ecg_lead_v3: "V3",
  mdc_ecg_lead_v4: "V4",
  mdc_ecg_lead_v5: "V5",
  mdc_ecg_lead_v6: "V6",
  telemetry: "II",
  mcl: "V1",
  "mcl-1": "V1",
  "ii telemetry": "II",
};

function normalizeLeadKey(raw: string): LeadId | null {
  const k = raw.trim().toLowerCase().replace(/[_\s]+/g, " ").replace(/^lead\s+/, "lead ");
  const compact = k.replace(/\s+/g, "");
  return (
    LEAD_ALIASES[k] ??
    LEAD_ALIASES[compact] ??
    LEAD_ALIASES[`mdc_ecg_lead_${compact}`] ??
    null
  );
}

function layoutFromLeads(leads: LeadId[]): UploadLayout {
  const set = new Set(leads);
  if (leads.length <= 1) return "telemetry";
  if (leads.length === 2) return "rhythm";
  const limb = (["I", "II", "III", "aVR", "aVL", "aVF"] as LeadId[]).every((l) => set.has(l));
  const prec = (["V1", "V2", "V3", "V4", "V5", "V6"] as LeadId[]).every((l) => set.has(l));
  if (limb && prec) return "full12";
  if (limb && leads.length <= 6) return "limb6";
  if (prec && leads.length <= 6) return "precordial6";
  return "partial";
}

function preferRhythmLead(available: LeadId[]): LeadId {
  const order: LeadId[] = ["II", "V1", "I", "V5", "III", "aVF", "V2", "V3", "V4", "V6", "aVL", "aVR"];
  for (const id of order) if (available.includes(id)) return id;
  return available[0] ?? "II";
}

function finalizeUpload(opts: {
  name: string;
  imageUrl: string | null;
  leadSignals: Partial<Record<LeadId, Float32Array>>;
  sourceKind: UploadedEkg["sourceKind"];
  sampleRateHz?: number;
  leadLabels?: Partial<Record<LeadId, string>>;
}): UploadedEkg {
  let availableLeads = LEADS.filter((l) => opts.leadSignals[l] && opts.leadSignals[l]!.length > 8);
  if (!availableLeads.length) {
    throw new Error("No usable EKG samples found in file");
  }

  // Resample all leads to a shared length
  const targetLen = Math.max(
    ...availableLeads.map((l) => opts.leadSignals[l]!.length),
    64,
  );
  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  for (const id of availableLeads) {
    // Robust normalize: outliers/saturation must not crush the QRS
    leadSignals[id] = normalizeSignalRobust(resample(opts.leadSignals[id]!, targetLen));
  }

  const rhythmId = preferRhythmLead(availableLeads);
  const signal = leadSignals[rhythmId]!;
  const rPeaks = detectRPeaks(signal);
  let durationSec = 5;
  if (opts.sampleRateHz && opts.sampleRateHz > 10) {
    durationSec = Math.max(1.5, Math.min(60, targetLen / opts.sampleRateHz));
  } else if (rPeaks.length >= 2) {
    const meanRrPx = (rPeaks[rPeaks.length - 1]! - rPeaks[0]!) / (rPeaks.length - 1);
    durationSec = Math.max(2.5, Math.min(30, (targetLen / meanRrPx) * 0.85));
  } else {
    durationSec = Math.max(2.5, Math.min(20, targetLen / 120));
  }
  const rateBpm = estimateRate(rPeaks, durationSec, targetLen);
  const layout = layoutFromLeads(availableLeads);

  return {
    name: opts.name,
    imageUrl: opts.imageUrl,
    signal,
    leadSignals,
    availableLeads,
    leadLabels: opts.leadLabels,
    layout,
    durationSec,
    rateBpm,
    rPeaks,
    sampleRateHz: opts.sampleRateHz,
    sourceKind: opts.sourceKind,
  };
}

/** Route by MIME / extension */
export async function parseEkgFile(file: File): Promise<UploadedEkg> {
  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();

  if (
    type.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|bmp|tif{1,2})$/i.test(file.name)
  ) {
    return parseEkgImage(file);
  }
  const text = await file.text();
  if (type.includes("json") || name.endsWith(".json")) {
    return parseEkgJson(file.name, text);
  }
  if (type.includes("xml") || name.endsWith(".xml") || text.includes("<AnnotatedECG") || text.includes("MDC_ECG_LEAD")) {
    return parseEkgXml(file.name, text);
  }
  if (type.includes("csv") || name.endsWith(".csv") || name.endsWith(".txt") || looksLikeCsv(text)) {
    return parseEkgCsv(file.name, text);
  }
  // Fallback: try CSV then JSON
  try {
    return parseEkgCsv(file.name, text);
  } catch {
    return parseEkgJson(file.name, text);
  }
}

/** @deprecated use parseEkgFile */
export async function parseEkgImage(file: File): Promise<UploadedEkg> {
  const imageUrl = URL.createObjectURL(file);
  const img = await loadImage(imageUrl);

  const w = Math.min(1400, img.naturalWidth);
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read EKG image");
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const bands = detectInkBands(data, w, h);
  const aspect = w / Math.max(1, h);

  // Telemetry / single rhythm strip: wide short image or one ink band
  if (bands.length <= 1 || aspect > 3.2) {
    const y0 = bands[0]?.y0 ?? Math.floor(h * 0.15);
    const y1 = bands[0]?.y1 ?? Math.floor(h * 0.85);
    const signal = extractBandSignal(data, w, h, y0, y1, 0, w);
    return finalizeUpload({
      name: file.name,
      imageUrl,
      leadSignals: { II: signal },
      sourceKind: "image",
    });
  }

  // Multi-row printed EKG: extract each band; if 3–4 rows try 4-column classic layout
  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  const classicOrder: LeadId[] = [
    "I",
    "aVR",
    "V1",
    "V4",
    "II",
    "aVL",
    "V2",
    "V5",
    "III",
    "aVF",
    "V3",
    "V6",
  ];

  if (bands.length >= 3 && bands.length <= 5) {
    // Bottom band often rhythm strip
    const gridBands = bands.length >= 4 ? bands.slice(0, 3) : bands.slice(0, Math.min(3, bands.length));
    const rhythmBand = bands.length >= 4 ? bands[bands.length - 1]! : null;

    let col = 0;
    for (const band of gridBands) {
      for (let c = 0; c < 4; c++) {
        const id = classicOrder[col++];
        if (!id) break;
        const x0 = Math.floor((c / 4) * w);
        const x1 = Math.floor(((c + 1) / 4) * w);
        leadSignals[id] = extractBandSignal(data, w, h, band.y0, band.y1, x0, x1);
      }
    }
    if (rhythmBand) {
      leadSignals.II = extractBandSignal(data, w, h, rhythmBand.y0, rhythmBand.y1, 0, w);
    }
  } else {
    // Generic: map bands top→bottom onto common lead order
    const order: LeadId[] = ["II", "I", "III", "V1", "V2", "V3", "V4", "V5", "V6", "aVR", "aVL", "aVF"];
    for (let i = 0; i < bands.length && i < order.length; i++) {
      const b = bands[i]!;
      leadSignals[order[i]!] = extractBandSignal(data, w, h, b.y0, b.y1, 0, w);
    }
  }

  return finalizeUpload({
    name: file.name,
    imageUrl,
    leadSignals,
    sourceKind: "image",
  });
}

function detectInkBands(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { y0: number; y1: number }[] {
  const rowInk = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let ink = 0;
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      const lum = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      ink += Math.max(0, 165 - lum);
    }
    rowInk[y] = ink;
  }
  // Smooth projection
  const smooth = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    let n = 0;
    for (let d = -3; d <= 3; d++) {
      const j = y + d;
      if (j < 0 || j >= h) continue;
      s += rowInk[j]!;
      n++;
    }
    smooth[y] = s / n;
  }
  const maxInk = Math.max(...smooth, 1);
  const thresh = maxInk * 0.18;
  const bands: { y0: number; y1: number }[] = [];
  let inBand = false;
  let y0 = 0;
  for (let y = 0; y < h; y++) {
    const on = smooth[y]! > thresh;
    if (on && !inBand) {
      inBand = true;
      y0 = y;
    } else if (!on && inBand) {
      inBand = false;
      if (y - y0 > h * 0.04) bands.push({ y0, y1: y });
    }
  }
  if (inBand && h - y0 > h * 0.04) bands.push({ y0, y1: h });

  // Merge tiny gaps
  const merged: { y0: number; y1: number }[] = [];
  for (const b of bands) {
    const prev = merged[merged.length - 1];
    if (prev && b.y0 - prev.y1 < h * 0.025) prev.y1 = b.y1;
    else merged.push({ ...b });
  }
  return merged.slice(0, 8);
}

function extractBandSignal(
  data: Uint8ClampedArray,
  w: number,
  _h: number,
  y0: number,
  y1: number,
  x0: number,
  x1: number,
): Float32Array {
  const xStart = Math.max(0, Math.min(w - 1, x0));
  const xEnd = Math.max(xStart + 1, Math.min(w, x1));
  const raw = new Float32Array(xEnd - xStart);
  for (let x = xStart; x < xEnd; x++) {
    let sumY = 0;
    let sumW = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * w + x) * 4;
      const lum = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      const ink = Math.max(0, 170 - lum);
      if (ink > 12) {
        sumY += y * ink;
        sumW += ink;
      }
    }
    raw[x - xStart] = sumW > 0 ? -(sumY / sumW) : Number.NaN;
  }
  fillGaps(raw);
  return smoothSignal(raw);
}

function looksLikeCsv(text: string): boolean {
  const lines = text.trim().split(/\r?\n/).slice(0, 5);
  if (lines.length < 2) return false;
  const delim = lines[0]!.includes("\t") ? "\t" : ",";
  return lines[0]!.split(delim).length >= 1 && /[0-9.\-]/.test(lines[1] ?? "");
}

function parseEkgCsv(name: string, text: string): UploadedEkg {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !l.startsWith("#"));
  if (lines.length < 2) throw new Error("CSV has no samples");

  const delim = lines[0]!.includes("\t") ? "\t" : lines[0]!.includes(";") ? ";" : ",";
  const headerCells = splitCsvLine(lines[0]!, delim);
  const headerLeads = headerCells.map((c) => normalizeLeadKey(c));
  const hasLeadHeader = headerLeads.some((l) => l != null);

  let sampleRateHz: number | undefined;
  const leadCols: { id: LeadId; col: number }[] = [];
  let dataStart = 0;

  if (hasLeadHeader) {
    dataStart = 1;
    headerCells.forEach((cell, col) => {
      const id = normalizeLeadKey(cell);
      if (id) leadCols.push({ id, col });
      if (/rate|hz|fs|samp/i.test(cell) && false) {
        /* skip */
      }
    });
  } else {
    // Single column or unlabeled multi-column → treat first numeric col as II, extras as V1…
    const fallback: LeadId[] = ["II", "V1", "I", "III", "V2", "V3", "V4", "V5", "V6", "aVR", "aVL", "aVF"];
    const nCols = splitCsvLine(lines[0]!, delim).length;
    for (let c = 0; c < nCols && c < fallback.length; c++) {
      leadCols.push({ id: fallback[c]!, col: c });
    }
  }

  // Optional metadata line: sampleRate=250
  const meta = text.match(/sample\s*rate\s*[=:]\s*(\d+(?:\.\d+)?)/i);
  if (meta) sampleRateHz = Number(meta[1]);

  if (!leadCols.length) throw new Error("Could not map CSV columns to leads");

  const series: Record<string, number[]> = {};
  for (const { id } of leadCols) series[id] = [];

  for (let li = dataStart; li < lines.length; li++) {
    const cells = splitCsvLine(lines[li]!, delim);
    for (const { id, col } of leadCols) {
      const v = Number(cells[col]);
      if (Number.isFinite(v)) series[id]!.push(v);
    }
  }

  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  for (const { id } of leadCols) {
    const arr = series[id]!;
    if (arr.length > 8) leadSignals[id] = Float32Array.from(arr);
  }

  return finalizeUpload({
    name,
    imageUrl: null,
    leadSignals,
    sourceKind: name.toLowerCase().endsWith(".txt") ? "text" : "csv",
    sampleRateHz,
  });
}

function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      q = !q;
      continue;
    }
    if (!q && ch === delim) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function parseEkgJson(name: string, text: string): UploadedEkg {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON EKG file");
  }

  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  let sampleRateHz: number | undefined;

  const asObj = data as Record<string, unknown>;
  if (asObj && typeof asObj === "object") {
    if (typeof asObj.sampleRate === "number") sampleRateHz = asObj.sampleRate;
    if (typeof asObj.sample_rate === "number") sampleRateHz = asObj.sample_rate as number;
    if (typeof asObj.fs === "number") sampleRateHz = asObj.fs;

    const leadsNode = (asObj.leads ?? asObj.signals ?? asObj.channels ?? asObj) as Record<
      string,
      unknown
    >;
    for (const [key, val] of Object.entries(leadsNode)) {
      const id = normalizeLeadKey(key);
      if (!id) continue;
      if (Array.isArray(val)) {
        const nums = val.map(Number).filter(Number.isFinite);
        if (nums.length > 8) leadSignals[id] = Float32Array.from(nums);
      } else if (val && typeof val === "object" && Array.isArray((val as { data?: unknown }).data)) {
        const nums = ((val as { data: unknown[] }).data).map(Number).filter(Number.isFinite);
        if (nums.length > 8) leadSignals[id] = Float32Array.from(nums);
      }
    }

    // Flat array → telemetry II
    if (!Object.keys(leadSignals).length && Array.isArray(asObj.data)) {
      const nums = (asObj.data as unknown[]).map(Number).filter(Number.isFinite);
      if (nums.length > 8) leadSignals.II = Float32Array.from(nums);
    }
  }

  if (Array.isArray(data)) {
    const nums = data.map(Number).filter(Number.isFinite);
    if (nums.length > 8) leadSignals.II = Float32Array.from(nums);
  }

  return finalizeUpload({
    name,
    imageUrl: null,
    leadSignals,
    sourceKind: "json",
    sampleRateHz,
  });
}

/** Lightweight HL7 aECG / vendor XML lead extraction */
function parseEkgXml(name: string, text: string): UploadedEkg {
  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  let sampleRateHz: number | undefined;

  const rateMatch = text.match(/sampleRate[^0-9]*([0-9]+(?:\.[0-9]+)?)/i)
    ?? text.match(/<[Ii]ncrement[^>]*value="([0-9.]+)"/);
  if (rateMatch) {
    const v = Number(rateMatch[1]);
    // Increment is often seconds/sample
    sampleRateHz = v > 0 && v < 1 ? 1 / v : v;
  }

  // Pattern: lead code near digits list
  const codeBlocks = [
    ...text.matchAll(
      /(?:MDC_ECG_LEAD_([A-Za-z0-9]+)|code=["']?(?:LEAD[_ ]?)?([IV1-6avrAVRLf]+))[^<]{0,400}?<digits[^>]*>([^<]+)<\/digits>/gi,
    ),
  ];
  for (const m of codeBlocks) {
    const raw = (m[1] ?? m[2] ?? "").toString();
    const id = normalizeLeadKey(raw) ?? normalizeLeadKey(`MDC_ECG_LEAD_${raw}`);
    if (!id) continue;
    const nums = m[3]!
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter(Number.isFinite);
    if (nums.length > 8) leadSignals[id] = Float32Array.from(nums);
  }

  // Fallback: sequence code=II … SLIST
  if (!Object.keys(leadSignals).length) {
    for (const lead of LEADS) {
      const re = new RegExp(
        `${lead}[^<]{0,300}?<digits[^>]*>([^<]+)<\\/digits>`,
        "i",
      );
      const m = text.match(re);
      if (!m) continue;
      const nums = m[1]!
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      if (nums.length > 8) leadSignals[lead] = Float32Array.from(nums);
    }
  }

  // Last resort: first large digit dump as telemetry
  if (!Object.keys(leadSignals).length) {
    const dig = text.match(/<digits[^>]*>([^<]{80,})<\/digits>/i);
    if (dig) {
      const nums = dig[1]!
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
      if (nums.length > 8) leadSignals.II = Float32Array.from(nums);
    }
  }

  return finalizeUpload({
    name,
    imageUrl: null,
    leadSignals,
    sourceKind: "xml",
    sampleRateHz,
  });
}

function resample(src: Float32Array, len: number): Float32Array {
  if (src.length === len) return src.slice();
  const out = new Float32Array(len);
  const max = src.length - 1;
  for (let i = 0; i < len; i++) {
    const t = (i / Math.max(1, len - 1)) * max;
    const i0 = Math.floor(t);
    const i1 = Math.min(max, i0 + 1);
    const f = t - i0;
    out[i] = src[i0]! * (1 - f) + src[i1]! * f;
  }
  return out;
}

function fillGaps(raw: Float32Array) {
  const w = raw.length;
  for (let x = 0; x < w; x++) {
    if (!Number.isNaN(raw[x])) continue;
    let L = x - 1;
    let R = x + 1;
    while (L >= 0 && Number.isNaN(raw[L]!)) L--;
    while (R < w && Number.isNaN(raw[R]!)) R++;
    if (L >= 0 && R < w) {
      const t = (x - L) / (R - L);
      raw[x] = raw[L]! * (1 - t) + raw[R]! * t;
    } else if (L >= 0) raw[x] = raw[L]!;
    else if (R < w) raw[x] = raw[R]!;
    else raw[x] = 0;
  }
}

function smoothSignal(raw: Float32Array): Float32Array {
  const w = raw.length;
  const smooth = new Float32Array(w);
  const k = 3;
  for (let x = 0; x < w; x++) {
    let s = 0;
    let n = 0;
    for (let d = -k; d <= k; d++) {
      const j = x + d;
      if (j < 0 || j >= w) continue;
      s += raw[j]!;
      n++;
    }
    smooth[x] = s / n;
  }
  return smooth;
}

/** Mean-center and scale by a high percentile so spikes don't flatten the QRS */
function normalizeSignalRobust(smooth: Float32Array): Float32Array {
  const w = smooth.length;
  const out = smooth.slice();
  let sum = 0;
  for (let i = 0; i < w; i++) sum += out[i]!;
  const mean = sum / w;
  for (let i = 0; i < w; i++) out[i]! -= mean;

  const abs = Float32Array.from(out, (v) => Math.abs(v));
  abs.sort();
  const p99 = abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.99))] ?? 1;
  const scale = Math.max(p99, 1e-6);
  for (let i = 0; i < w; i++) {
    // Soft-clip extreme residuals so display stays readable
    out[i] = Math.max(-1.5, Math.min(1.5, out[i]! / scale));
  }
  return out;
}

function detectRPeaks(signal: Float32Array): number[] {
  const n = signal.length;
  const peaks: number[] = [];
  const minDist = Math.max(8, Math.floor(n / 40));
  // After robust normalize, QRS is typically ~0.5–1.2; keep threshold moderate
  const thresh = 0.28;
  for (let i = 2; i < n - 2; i++) {
    const v = signal[i]!;
    if (v < thresh) continue;
    if (v >= signal[i - 1]! && v >= signal[i + 1]! && v >= signal[i - 2]! && v >= signal[i + 2]!) {
      if (peaks.length && i - peaks[peaks.length - 1]! < minDist) {
        if (v > signal[peaks[peaks.length - 1]!]!) peaks[peaks.length - 1] = i;
      } else {
        peaks.push(i);
      }
    }
  }
  return peaks;
}

function estimateRate(peaks: number[], durationSec: number, width: number): number {
  if (peaks.length < 2) return 70;
  const intervals: number[] = [];
  for (let i = 1; i < peaks.length; i++) {
    const dt = ((peaks[i]! - peaks[i - 1]!) / (width - 1)) * durationSec;
    if (dt > 0.25 && dt < 2.5) intervals.push(dt);
  }
  if (!intervals.length) return 70;
  intervals.sort((a, b) => a - b);
  const med = intervals[Math.floor(intervals.length / 2)]!;
  return Math.round(60 / med);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load EKG image"));
    img.src = url;
  });
}

function markFromSlope(v: number, dv: number, nearPeak: boolean): {
  mark: CycleMark;
  phase: string;
  active: SegmentId[];
} {
  if (nearPeak || (dv > 0.08 && v > 0.2) || (dv < -0.08 && v > 0.15)) {
    return {
      mark: "QRS",
      phase: "Uploaded EKG · ventricular depolarization",
      active: ["his", "rbb", "lbb", "lbba", "lbbp", "purkinjeR", "purkinjeL", "myocardiumV"],
    };
  }
  if (v > 0.12 && Math.abs(dv) < 0.04) {
    return {
      mark: "ST",
      phase: "Uploaded EKG · ST segment",
      active: ["myocardiumV"],
    };
  }
  if (v > 0.05 && dv < 0 && !nearPeak) {
    return {
      mark: "T",
      phase: "Uploaded EKG · repolarization",
      active: ["myocardiumV"],
    };
  }
  if (v > 0.04 && v < 0.2 && dv > 0 && !nearPeak) {
    return {
      mark: "P",
      phase: "Uploaded EKG · atrial depolarization",
      active: ["sa", "internodal", "myocardiumA"],
    };
  }
  if (Math.abs(v) < 0.05) {
    return { mark: "TP", phase: "Uploaded EKG · baseline", active: [] };
  }
  return {
    mark: "PR",
    phase: "Uploaded EKG · conduction delay",
    active: ["av"],
  };
}

function sampleLead(upload: UploadedEkg, lead: LeadId, idxF: number): number {
  const series = upload.leadSignals[lead];
  if (!series || series.length < 2) return 0;
  const n = series.length;
  const i0 = Math.floor(idxF);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = idxF - i0;
  return series[i0]! * (1 - frac) + series[i1]! * frac;
}

/** Sample uploaded signal as a looping WaveSample */
export function sampleUploaded(upload: UploadedEkg, tNorm: number): WaveSample {
  const t = ((tNorm % 1) + 1) % 1;
  const n = upload.signal.length;
  const idxF = t * (n - 1);
  const i0 = Math.floor(idxF);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = idxF - i0;
  const v = upload.signal[i0]! * (1 - frac) + upload.signal[i1]! * frac;
  const prev = upload.signal[Math.max(0, i0 - 2)]!;
  const dv = v - prev;

  const nearPeak = upload.rPeaks.some((p) => Math.abs(p - idxF) < n * 0.02);
  const available = new Set(upload.availableLeads);
  const leads = emptyLeads();

  if (Object.keys(upload.leadSignals).length) {
    for (const lead of LEADS) {
      if (!available.has(lead)) {
        leads[lead] = 0;
        continue;
      }
      leads[lead] = sampleLead(upload, lead, idxF);
    }
  } else {
    for (const lead of LEADS) {
      leads[lead] = available.has(lead) ? v * (LEAD_W[lead] ?? 0.5) : 0;
    }
  }

  const meta = markFromSlope(v, dv, nearPeak);
  return { v: leads.II || v, leads, ...meta };
}

export function createUploadedFromLeads(opts: {
  name: string;
  leadSignals: Partial<Record<LeadId, Float32Array>>;
  sampleRateHz?: number;
  sourceKind?: UploadedEkg["sourceKind"];
  imageUrl?: string | null;
  leadLabels?: Partial<Record<LeadId, string>>;
}): UploadedEkg {
  return finalizeUpload({
    name: opts.name,
    imageUrl: opts.imageUrl ?? null,
    leadSignals: opts.leadSignals,
    sourceKind: opts.sourceKind ?? "text",
    sampleRateHz: opts.sampleRateHz,
    leadLabels: opts.leadLabels,
  });
}

export function suggestFindingFromUpload(upload: UploadedEkg): FindingId {
  if (upload.rateBpm < 50) return "sinusBrady";
  if (upload.rateBpm > 110) return "sinusTachy";
  return "nsr";
}

export function layoutLabel(layout: UploadLayout): string {
  switch (layout) {
    case "full12":
      return "12-lead";
    case "limb6":
      return "limb leads";
    case "precordial6":
      return "precordial";
    case "telemetry":
      return "telemetry";
    case "rhythm":
      return "rhythm strip";
    default:
      return "partial leads";
  }
}
