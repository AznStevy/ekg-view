import type { FindingId, SegmentId } from "./findings";
import type { CycleMark, LeadId, WaveSample } from "./ekgWaveforms";
import { LEADS } from "./ekgWaveforms";

/** How the uploaded recording should be shown */
export type UploadLayout = "full12" | "limb6" | "precordial6" | "telemetry" | "rhythm" | "partial";

/** One crop region used when parsing a paper EKG image */
export type UploadSplitRegion = {
  lead: LeadId | "rhythm";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type UploadedEkg = {
  name: string;
  /** Preview image when source was a raster; otherwise null */
  imageUrl: string | null;
  /** Annotated copy of the image showing how leads were split (images only) */
  splitPreviewUrl?: string | null;
  /** Crop boxes used for extraction (image coordinates at parse resolution) */
  splitRegions?: UploadSplitRegion[];
  /** Primary / rhythm channel (prefer II) — same length as leadSignals for grid */
  signal: Float32Array;
  /** Per-lead samples when available (same length as signal or resampled) */
  leadSignals: Partial<Record<LeadId, Float32Array>>;
  /**
   * Full-width bottom rhythm strip (Lead II) when longer than one grid column.
   * Grid leads stay one-column long so they do not wrap-duplicate beats.
   */
  rhythmSignal?: Float32Array;
  /** Duration of `rhythmSignal` in seconds (paper speed) */
  rhythmDurationSec?: number;
  /** Leads present in the recording */
  availableLeads: LeadId[];
  /** Optional original channel labels (e.g. MLII, V5) for display */
  leadLabels?: Partial<Record<LeadId, string>>;
  layout: UploadLayout;
  /** Loop length for the 12-lead grid (one column on paper) */
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
  splitPreviewUrl?: string | null;
  splitRegions?: UploadSplitRegion[];
  /** Full bottom rhythm strip (Lead II), longer than one grid column */
  rhythmSignal?: Float32Array;
  /**
   * Paper snapshot: keep physical mV. Grid leads share one column length;
   * optional rhythmSignal carries the full strip without forcing grid wraps.
   */
  snapshotExact?: boolean;
}): UploadedEkg {
  let availableLeads = LEADS.filter((l) => opts.leadSignals[l] && opts.leadSignals[l]!.length > 8);
  if (!availableLeads.length) {
    throw new Error("No usable EKG samples found in file");
  }

  const lengths = availableLeads.map((l) => opts.leadSignals[l]!.length);
  // Grid loop = one paper column (shared length). Prefer median so one narrow
  // column does not truncate beats off the others.
  const sortedLens = [...lengths].sort((a, b) => a - b);
  const medianLen = sortedLens[Math.floor(sortedLens.length / 2)]!;
  const targetLen = opts.snapshotExact
    ? Math.max(64, medianLen)
    : Math.max(...lengths, 64);

  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  if (opts.snapshotExact) {
    for (const id of availableLeads) {
      // Resample (not hard-truncate) so wider cells keep their last beat
      leadSignals[id] = resample(opts.leadSignals[id]!, targetLen);
    }
  } else {
    for (const id of availableLeads) {
      leadSignals[id] = normalizeSignalRobust(resample(opts.leadSignals[id]!, targetLen));
    }
  }

  const rhythmId = preferRhythmLead(availableLeads);
  const signal = leadSignals[rhythmId]!;
  const signalLen = signal.length;

  const rhythmSignal =
    opts.rhythmSignal && opts.rhythmSignal.length > signalLen * 1.25
      ? opts.rhythmSignal.slice()
      : undefined;

  // Rate from the longest continuous strip when available
  const rateSeries = rhythmSignal ?? signal;
  const rPeaks = detectRPeaks(rateSeries);
  let durationSec = 5;
  if (opts.sampleRateHz && opts.sampleRateHz > 10) {
    durationSec = Math.max(0.8, Math.min(30, signalLen / opts.sampleRateHz));
  } else if (rPeaks.length >= 2) {
    const meanRrPx =
      (rPeaks[rPeaks.length - 1]! - rPeaks[0]!) / (rPeaks.length - 1);
    durationSec = Math.max(0.8, Math.min(30, (signalLen / meanRrPx) * 0.85));
  } else {
    durationSec = Math.max(0.8, Math.min(20, signalLen / 120));
  }

  let rhythmDurationSec: number | undefined;
  if (rhythmSignal && opts.sampleRateHz && opts.sampleRateHz > 10) {
    rhythmDurationSec = Math.max(durationSec, rhythmSignal.length / opts.sampleRateHz);
  } else if (rhythmSignal) {
    rhythmDurationSec = durationSec * (rhythmSignal.length / Math.max(1, signalLen));
  }

  // Recompute duration from paper speed when Hz is known (avoids peak-based drift)
  if (opts.sampleRateHz && opts.sampleRateHz > 10) {
    durationSec = Math.max(0.8, Math.min(30, signalLen / opts.sampleRateHz));
  }

  const rateBpm = estimateRate(
    rPeaks,
    rhythmDurationSec ?? durationSec,
    rateSeries.length,
  );
  const layout = layoutFromLeads(availableLeads);

  return {
    name: opts.name,
    imageUrl: opts.imageUrl,
    splitPreviewUrl: opts.splitPreviewUrl ?? null,
    splitRegions: opts.splitRegions,
    signal,
    leadSignals,
    rhythmSignal,
    rhythmDurationSec,
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

/** Classic 3×4 column order (Wave-Maven / hospital printouts). */
const CLASSIC_12_ORDER: LeadId[] = [
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

export async function parseEkgImage(file: File): Promise<UploadedEkg> {
  const imageUrl = URL.createObjectURL(file);
  const img = await loadImage(imageUrl);

  const w = Math.min(1600, img.naturalWidth);
  const h = Math.round((img.naturalHeight / img.naturalWidth) * w);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read EKG image");
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Suppress pink/red grid; keep dark ink + blue labels/dividers for layout cues
  const ink = buildInkMask(data, w, h);
  const blue = buildBlueMask(data, w, h);
  const boxPx = detectLargeBoxPitch(data, w, h) || Math.max(8, Math.round(w / 50));
  // 1 large box = 5 mm at standard paper; used for time/voltage via boxPx
  const secPerPx = 0.2 / boxPx; // 25 mm/s
  const mvPerPx = estimateMvPerPx(ink, w, h, boxPx) || 1 / (2 * boxPx);

  const colXs = detectColumnDividers(blue, w, h);
  const bands = detectInkBandsFromMask(ink, w, h);
  const aspect = w / Math.max(1, h);

  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  const splitRegions: UploadSplitRegion[] = [];

  // Classic Wave-Maven / hospital printout: 3 blue column dividers → 3×4 + rhythm
  // Prefer geometry over ink bands (tall QRS often merges rows into 1–2 bands).
  const classic12 = colXs.length >= 3 || (aspect >= 1.25 && aspect <= 2.4 && bands.length >= 3);

  if (classic12) {
    const cols =
      colXs.length >= 3
        ? [0, ...colXs.slice(0, 3), w]
        : [0, Math.floor(w * 0.25), Math.floor(w * 0.5), Math.floor(w * 0.75), w];
    while (cols.length < 5) cols.push(w);

    const rows = detectClassic12Rows(ink, w, h, bands);
    const shortLeads: Partial<Record<LeadId, Float32Array>> = {};
    let idx = 0;
    let shortest = Infinity;
    for (let r = 0; r < 3; r++) {
      const band = rows[r]!;
      for (let c = 0; c < 4; c++) {
        const id = CLASSIC_12_ORDER[idx++]!;
        const x0 = cols[c]!;
        const x1 = cols[c + 1]!;
        // Skip calibration pulse on far left of first column
        const pad = c === 0 ? Math.min(Math.floor((x1 - x0) * 0.14), boxPx * 2.5) : Math.floor(boxPx * 0.2);
        const rx0 = x0 + pad;
        const rx1 = x1 - 2;
        splitRegions.push({ lead: id, x0: rx0, y0: band.y0, x1: rx1, y1: band.y1 });
        const sig = extractBandMv(ink, w, band.y0, band.y1, rx0, rx1, mvPerPx);
        shortLeads[id] = sig;
        shortest = Math.min(shortest, sig.length);
      }
    }
    shortest = Math.max(64, Number.isFinite(shortest) ? shortest : 64);
    // Median length across cells — resample later in finalize (avoid hard truncate)
    const cellLens = CLASSIC_12_ORDER.map((id) => shortLeads[id]?.length ?? shortest);
    cellLens.sort((a, b) => a - b);
    const gridLen = Math.max(64, cellLens[Math.floor(cellLens.length / 2)]!);

    // Bottom rhythm strip: keep the entire strip separately (do not replace grid II)
    let rhythmSignal: Float32Array | undefined;
    const rhythm = rows[3];
    if (rhythm) {
      const rx0 = Math.floor(boxPx * 1.2);
      rhythmSignal = extractBandMv(ink, w, rhythm.y0, rhythm.y1, rx0, w, mvPerPx);
      splitRegions.push({
        lead: "rhythm",
        x0: rx0,
        y0: rhythm.y0,
        x1: w,
        y1: rhythm.y1,
      });
      // Prefer continuous strip morphology for grid II when the cell is short
      // (still one-column length after finalize resample)
      if (rhythmSignal.length > gridLen) {
        shortLeads.II = rhythmSignal.slice(0, Math.min(rhythmSignal.length, Math.round(rhythmSignal.length / 4)));
      }
    }

    Object.assign(leadSignals, shortLeads);

    const nLeads = Object.keys(leadSignals).length;
    if (nLeads < 1) {
      URL.revokeObjectURL(imageUrl);
      throw new Error("Could not find a 12-lead grid or rhythm strip in this image");
    }

    const splitPreviewUrl = renderSplitPreview(canvas, splitRegions);
    const sampleRateHz = Math.max(50, Math.round(1 / secPerPx));
    return finalizeUpload({
      name: file.name,
      imageUrl,
      leadSignals,
      sourceKind: "image",
      sampleRateHz,
      splitPreviewUrl,
      splitRegions,
      snapshotExact: true,
      rhythmSignal,
    });
  } else if ((bands.length <= 1 && colXs.length < 2) || aspect > 3.4) {
    // Telemetry / single strip
    const y0 = bands[0]?.y0 ?? Math.floor(h * 0.12);
    const y1 = bands[0]?.y1 ?? Math.floor(h * 0.88);
    splitRegions.push({ lead: "II", x0: 0, y0, x1: w, y1 });
    leadSignals.II = extractBandMv(ink, w, y0, y1, 0, w, mvPerPx);
  } else {
    // Stacked multi-channel strip without clear columns
    const order: LeadId[] = ["II", "I", "III", "V1", "V2", "V3", "V4", "V5", "V6", "aVR", "aVL", "aVF"];
    for (let i = 0; i < bands.length && i < order.length; i++) {
      const b = bands[i]!;
      const id = order[i]!;
      splitRegions.push({ lead: id, x0: 0, y0: b.y0, x1: w, y1: b.y1 });
      leadSignals[id] = extractBandMv(ink, w, b.y0, b.y1, 0, w, mvPerPx);
    }
  }

  const nLeads = Object.keys(leadSignals).length;
  if (nLeads < 1) {
    URL.revokeObjectURL(imageUrl);
    throw new Error("Could not find a 12-lead grid or rhythm strip in this image");
  }

  const splitPreviewUrl = renderSplitPreview(canvas, splitRegions);
  const sampleRateHz = Math.max(50, Math.round(1 / secPerPx));
  return finalizeUpload({
    name: file.name,
    imageUrl,
    leadSignals,
    sourceKind: "image",
    sampleRateHz,
    splitPreviewUrl,
    splitRegions,
    snapshotExact: classic12,
  });
}

const SPLIT_COLORS = [
  "#3db8c8",
  "#f0c040",
  "#7ec87a",
  "#c070ff",
  "#ff8844",
  "#8eb0ff",
  "#e07090",
  "#60d0a0",
  "#d0a060",
  "#70a0e0",
  "#c0c050",
  "#a080e0",
  "#ff6b6b",
];

/** Draw labeled crop boxes on a copy of the parsed image for the upload preview. */
function renderSplitPreview(
  source: HTMLCanvasElement,
  regions: UploadSplitRegion[],
): string | null {
  if (!regions.length) return null;
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0);
  const fontPx = Math.max(11, Math.round(source.width / 70));
  ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textBaseline = "top";

  regions.forEach((r, i) => {
    const color = SPLIT_COLORS[i % SPLIT_COLORS.length]!;
    const x = r.x0;
    const y = r.y0;
    const rw = Math.max(1, r.x1 - r.x0);
    const rh = Math.max(1, r.y1 - r.y0);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, source.width / 500);
    ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    const label = r.lead === "rhythm" ? "II rhythm" : r.lead;
    const tw = ctx.measureText(label).width + 8;
    const th = fontPx + 6;
    ctx.fillRect(x + 2, y + 2, tw, th);
    ctx.fillStyle = color;
    ctx.fillText(label, x + 6, y + 5);
  });

  return out.toDataURL("image/png");
}

/**
 * Split a classic printout into 3 short-lead rows + bottom rhythm strip.
 * Uses geometry first (Wave-Maven), refined by left-margin calibration pulses
 * or ink valleys when available.
 */
function detectClassic12Rows(
  ink: Float32Array,
  w: number,
  h: number,
  bands: { y0: number; y1: number }[],
): { y0: number; y1: number }[] {
  const top = Math.floor(h * 0.02);
  const bot = Math.floor(h * 0.97);
  const usable = bot - top;

  // Prefer 4 clear horizontal bands when ink separation works
  if (bands.length >= 4) {
    const four = bands.slice(0, 4);
    const heights = four.map((b) => b.y1 - b.y0);
    const maxH = Math.max(...heights);
    // Rhythm strip is usually similar height to a grid row; accept as-is
    if (maxH < h * 0.45) {
      return four.map((b) => ({
        y0: Math.max(0, b.y0 - 2),
        y1: Math.min(h, b.y1 + 2),
      }));
    }
  }

  // Left-margin calibration pulses mark each row's baseline
  const calYs = detectCalibrationRowCenters(ink, w, h);
  if (calYs.length >= 4) {
    const centers = calYs.slice(0, 4);
    const rows: { y0: number; y1: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const prev = i === 0 ? top : (centers[i - 1]! + centers[i]!) * 0.5;
      const next = i === 3 ? bot : (centers[i]! + centers[i + 1]!) * 0.5;
      rows.push({ y0: Math.floor(prev), y1: Math.floor(next) });
    }
    return rows;
  }

  // Geometry fallback: equal quarters (Wave-Maven / most hospital printouts)
  const rowH = Math.floor(usable / 4);
  return [0, 1, 2, 3].map((i) => ({
    y0: top + i * rowH,
    y1: i === 3 ? bot : top + (i + 1) * rowH,
  }));
}

/** Find ~4 calibration-pulse centers along the left margin. */
function detectCalibrationRowCenters(ink: Float32Array, w: number, h: number): number[] {
  const x1 = Math.min(w, Math.floor(w * 0.09));
  const row = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 2; x < x1; x++) s += ink[y * w + x]!;
    row[y] = s;
  }
  // Smooth
  const sm = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    let n = 0;
    for (let d = -3; d <= 3; d++) {
      const j = y + d;
      if (j < 0 || j >= h) continue;
      s += row[j]!;
      n++;
    }
    sm[y] = s / n;
  }
  const max = Math.max(...sm, 1);
  const thresh = max * 0.28;
  const peaks: number[] = [];
  for (let y = Math.floor(h * 0.04); y < Math.floor(h * 0.95); y++) {
    if (sm[y]! < thresh) continue;
    if (sm[y]! >= sm[y - 1]! && sm[y]! >= sm[y + 1]!) {
      if (!peaks.length || y - peaks[peaks.length - 1]! > h * 0.1) peaks.push(y);
      else if (sm[y]! > sm[peaks[peaks.length - 1]!]!) peaks[peaks.length - 1] = y;
    }
  }
  return peaks.slice(0, 4);
}

/** Dark ink only — pink/red grid pixels are suppressed. */
function buildInkMask(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const ink = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const lum = (r + g + b) / 3;
    // Pink/red grid: high R relative to G/B, not very dark
    const pinkish = r > g + 18 && r > b + 18 && lum > 155;
    // Blue labels/dividers — exclude from ink trace
    const blueish = b > r + 25 && b > g + 10 && lum > 60 && lum < 200;
    if (pinkish || blueish) {
      ink[p] = 0;
      continue;
    }
    // Keep soft grey Wave-Maven traces (lum often 90–140)
    ink[p] = lum < 185 ? Math.max(0, 200 - lum) : 0;
  }
  return ink;
}

function buildBlueMask(data: Uint8ClampedArray, w: number, h: number): Float32Array {
  const blue = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const lum = (r + g + b) / 3;
    blue[p] = b > r + 30 && b > g + 15 && lum > 50 && lum < 210 ? 1 : 0;
  }
  return blue;
}

/** Estimate large-box pitch (px) from horizontal grid autocorrelation on mid rows. */
function detectLargeBoxPitch(data: Uint8ClampedArray, w: number, h: number): number {
  const y0 = Math.floor(h * 0.2);
  const y1 = Math.floor(h * 0.55);
  const proj = new Float32Array(w);
  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      // Emphasize pink grid lines
      const pink = r > g + 12 && r > b + 12 ? (r - Math.min(g, b)) / 255 : 0;
      proj[x]! += pink;
    }
  }
  const minLag = Math.max(6, Math.floor(w / 80));
  const maxLag = Math.min(Math.floor(w / 12), 80);
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let x = 0; x < w - lag; x += 2) s += proj[x]! * proj[x + lag]!;
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  // Prefer multiples that look like 5 small boxes; bestLag is often 1 small box
  // Large box = 5 small → try 5× if small
  if (bestLag > 0 && bestLag < 14) return bestLag * 5;
  return bestLag;
}

function estimateMvPerPx(ink: Float32Array, w: number, h: number, boxPx: number): number {
  // Standard paper gain: 10 mm = 1 mV = 2 large boxes
  const stdMvPerPx = 1 / (2 * boxPx);
  // Look for the 1 mV calibration square-wave height on the left margin
  const x1 = Math.min(w, Math.floor(boxPx * 4));
  let calSpan = 0;
  for (let x = 2; x < x1; x++) {
    let yTop = -1;
    let yBot = -1;
    for (let y = 0; y < h; y++) {
      if (ink[y * w + x]! > 40) {
        if (yTop < 0) yTop = y;
        yBot = y;
      }
    }
    if (yTop >= 0) calSpan = Math.max(calSpan, yBot - yTop);
  }
  if (calSpan > boxPx * 1.4 && calSpan < boxPx * 10) {
    return 1 / calSpan;
  }
  return stdMvPerPx;
}

function detectColumnDividers(blue: Float32Array, w: number, h: number): number[] {
  const y0 = Math.floor(h * 0.05);
  const y1 = Math.floor(h * 0.72);
  const col = new Float32Array(w);
  for (let y = y0; y < y1; y += 2) {
    for (let x = 0; x < w; x++) col[x]! += blue[y * w + x]!;
  }
  // Smooth
  const sm = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    let n = 0;
    for (let d = -2; d <= 2; d++) {
      const j = x + d;
      if (j < 0 || j >= w) continue;
      s += col[j]!;
      n++;
    }
    sm[x] = s / n;
  }
  const max = Math.max(...sm, 1);
  const thresh = max * 0.35;
  const peaks: number[] = [];
  for (let x = Math.floor(w * 0.15); x < Math.floor(w * 0.9); x++) {
    if (sm[x]! < thresh) continue;
    if (sm[x]! >= sm[x - 1]! && sm[x]! >= sm[x + 1]!) {
      if (!peaks.length || x - peaks[peaks.length - 1]! > w * 0.12) peaks.push(x);
      else if (sm[x]! > sm[peaks[peaks.length - 1]!]!) peaks[peaks.length - 1] = x;
    }
  }
  return peaks.slice(0, 3);
}

function detectInkBandsFromMask(ink: Float32Array, w: number, h: number): { y0: number; y1: number }[] {
  const rowInk = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x += 2) s += ink[y * w + x]!;
    rowInk[y] = s;
  }
  const smooth = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    let n = 0;
    for (let d = -4; d <= 4; d++) {
      const j = y + d;
      if (j < 0 || j >= h) continue;
      s += rowInk[j]!;
      n++;
    }
    smooth[y] = s / n;
  }
  const maxInk = Math.max(...smooth, 1);
  const thresh = maxInk * 0.14;
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
      if (y - y0 > h * 0.035) bands.push({ y0, y1: y });
    }
  }
  if (inBand && h - y0 > h * 0.035) bands.push({ y0, y1: h });
  const merged: { y0: number; y1: number }[] = [];
  for (const b of bands) {
    const prev = merged[merged.length - 1];
    if (prev && b.y0 - prev.y1 < h * 0.02) prev.y1 = b.y1;
    else merged.push({ ...b });
  }
  return merged.slice(0, 8);
}

function extractBandMv(
  ink: Float32Array,
  w: number,
  y0: number,
  y1: number,
  x0: number,
  x1: number,
  mvPerPx: number,
): Float32Array {
  const xStart = Math.max(0, Math.min(w - 1, x0));
  const xEnd = Math.max(xStart + 1, Math.min(w, x1));
  const hImg = Math.floor(ink.length / w);
  const hCell = Math.max(1, y1 - y0);
  // Core of the labeled cell — baseline only (skip lead-name strip)
  const yCore0 = y0 + Math.max(2, Math.floor(hCell * 0.12));
  const yCore1 = y1 - Math.max(1, Math.floor(hCell * 0.03));
  const edgePad = Math.max(2, Math.floor(hCell * 0.04));
  // Hard limit on per-column jumps so we never leap to a neighboring lead's ink
  // (same-column V5/V6 under V4, etc.). Overflow still allowed — just continuous.
  const maxStep = Math.max(18, Math.floor(hCell * 0.55));

  const ys = new Float32Array(xEnd - xStart);
  let prevY = (yCore0 + yCore1) * 0.5;
  let velY = 0;
  // Grow search while the stroke is outside / on the edge; shrink once back in-core.
  let searchR = Math.max(14, Math.floor(hCell * 0.4));

  for (let x = xStart; x < xEnd; x++) {
    const i = x - xStart;
    const hitTop = prevY <= y0 + edgePad;
    const hitBot = prevY >= y1 - edgePad;
    const outsideBox = prevY < y0 || prevY >= y1;

    if (hitTop || hitBot || outsideBox) {
      // Keep opening the window in the travel direction — no amplitude ceiling
      searchR = Math.min(
        hImg,
        Math.max(searchR + Math.abs(velY) + 6, Math.abs(velY) * 2 + hCell * 0.35, maxStep),
      );
    } else if (prevY >= yCore0 && prevY < yCore1) {
      searchR = Math.max(14, Math.floor(hCell * 0.4));
    }

    const expectY = prevY + velY * 0.85;
    // Window always centered on the predicted stroke — never a full-column scan
    // (that was stealing V4 onto V5/V6 deep waves).
    let yA = Math.max(0, Math.floor(Math.min(prevY, expectY) - searchR));
    let yB = Math.min(hImg, Math.ceil(Math.max(prevY, expectY) + searchR));
    // When pinned to a box edge, bias the window past that edge only
    if (hitTop || prevY < y0) {
      yA = Math.max(0, Math.floor(prevY - searchR));
      yB = Math.min(hImg, Math.ceil(Math.max(y1, prevY) + Math.min(searchR, hCell * 0.4)));
    } else if (hitBot || prevY >= y1) {
      yA = Math.max(0, Math.floor(Math.min(y0, prevY) - Math.min(searchR, hCell * 0.4)));
      yB = Math.min(hImg, Math.ceil(prevY + searchR));
    }

    let bestY = -1;
    let bestScore = -Infinity;
    for (let y = yA; y < yB; y++) {
      const v = ink[y * w + x]!;
      if (v < 12) continue;
      const jump = Math.abs(y - expectY);
      if (jump > maxStep && jump > Math.abs(velY) * 2.5 + 10) continue;
      // Continuity-first: prefer the same stroke over stronger distant ink
      const score = v * 0.35 - jump * 1.15;
      if (score > bestScore) {
        bestScore = score;
        bestY = y;
      }
    }

    // Widen once around the predicted point if the local window missed
    if (bestY < 0) {
      const widen = Math.min(hImg, Math.max(searchR * 2, maxStep * 2));
      yA = Math.max(0, Math.floor(expectY - widen));
      yB = Math.min(hImg, Math.ceil(expectY + widen));
      for (let y = yA; y < yB; y++) {
        const v = ink[y * w + x]!;
        if (v < 12) continue;
        const jump = Math.abs(y - expectY);
        if (jump > maxStep * 1.5) continue;
        const score = v * 0.35 - jump * 1.15;
        if (score > bestScore) {
          bestScore = score;
          bestY = y;
        }
      }
    }

    if (bestY >= 0) {
      let sumY = 0;
      let sumW = 0;
      for (let y = Math.max(0, bestY - 2); y <= Math.min(hImg - 1, bestY + 2); y++) {
        const v = ink[y * w + x]!;
        if (v < 12) continue;
        // Don't blend in ink that's far from the chosen stroke
        if (Math.abs(y - bestY) > 2) continue;
        sumY += y * v;
        sumW += v;
      }
      const yTrace = sumW > 0 ? sumY / sumW : bestY;
      ys[i] = yTrace;
      velY = 0.65 * (yTrace - prevY) + 0.35 * velY;
      prevY = yTrace;
    } else {
      ys[i] = Number.NaN;
      prevY = Math.max(0, Math.min(hImg - 1, prevY + velY * 0.5));
      velY *= 0.7;
    }
  }

  fillGaps(ys);

  // Isoelectric from flat segments in the row core (overflow peaks excluded)
  const rowCenterY = (yCore0 + yCore1) * 0.5;
  const flatYs: number[] = [];
  for (let i = 1; i < ys.length - 1; i++) {
    const y = ys[i]!;
    if (!Number.isFinite(y) || y < yCore0 || y >= yCore1) continue;
    const dy = Math.abs(ys[i]! - ys[i - 1]!) + Math.abs(ys[i + 1]! - ys[i]!);
    if (dy < 4) flatYs.push(y);
  }
  let baselineY = rowCenterY;
  if (flatYs.length > 6) {
    flatYs.sort((a, b) => a - b);
    baselineY = flatYs[Math.floor(flatYs.length * 0.5)]!;
  }

  const raw = new Float32Array(ys.length);
  for (let i = 0; i < ys.length; i++) {
    raw[i] = (baselineY - ys[i]!) * mvPerPx;
  }
  return raw;
}

/** Downloadable CSV of uploaded lead voltages */
export function exportUploadedCsv(upload: UploadedEkg): string {
  const leads = upload.availableLeads;
  const n = Math.max(...leads.map((l) => upload.leadSignals[l]?.length ?? 0), 0);
  const hz = upload.sampleRateHz ?? n / Math.max(0.001, upload.durationSec);
  const lines: string[] = [`# sampleRateHz=${hz.toFixed(2)}`, `time_s,${leads.join(",")}`];
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    const row = [t.toFixed(4)];
    for (const id of leads) {
      const s = upload.leadSignals[id];
      row.push(s && i < s.length ? s[i]!.toFixed(5) : "");
    }
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

/** Lightweight HL7 aECG-style XML of uploaded leads */
export function exportUploadedAecgXml(upload: UploadedEkg): string {
  const hz = upload.sampleRateHz ?? upload.signal.length / Math.max(0.001, upload.durationSec);
  const increment = 1 / hz;
  const chunks = upload.availableLeads.map((id) => {
    const s = upload.leadSignals[id]!;
    const digits = Array.from(s, (v) => v.toFixed(4)).join(" ");
    return `  <sequence>
    <code code="MDC_ECG_LEAD_${id}"/>
    <value>
      <increment value="${increment.toFixed(6)}" unit="s"/>
      <digits>${digits}</digits>
    </value>
  </sequence>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<AnnotatedECG>
  <name>${escapeXml(upload.name)}</name>
  <sampleRate value="${hz.toFixed(2)}"/>
${chunks.join("\n")}
</AnnotatedECG>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
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
  let peakAbs = 0;
  for (let i = 0; i < n; i++) peakAbs = Math.max(peakAbs, Math.abs(signal[i]!));
  const thresh = Math.max(0.12, peakAbs * 0.32);
  for (let i = 2; i < n - 2; i++) {
    const v = signal[i]!;
    if (Math.abs(v) < thresh) continue;
    if (
      Math.abs(v) >= Math.abs(signal[i - 1]!) &&
      Math.abs(v) >= Math.abs(signal[i + 1]!) &&
      Math.abs(v) >= Math.abs(signal[i - 2]!) &&
      Math.abs(v) >= Math.abs(signal[i + 2]!)
    ) {
      if (peaks.length && i - peaks[peaks.length - 1]! < minDist) {
        if (Math.abs(v) > Math.abs(signal[peaks[peaks.length - 1]!]!)) peaks[peaks.length - 1] = i;
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
  if (nearPeak || (Math.abs(dv) > 0.12 && Math.abs(v) > 0.2)) {
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
  // Clamp — grid leads share one length; no wrap (wrap was duplicating/cutting beats)
  const clamped = Math.max(0, Math.min(n - 1.0001, idxF));
  const i0 = Math.floor(clamped);
  const i1 = Math.min(n - 1, i0 + 1);
  const frac = clamped - i0;
  return series[i0]! * (1 - frac) + series[i1]! * frac;
}

/** Sample the full-width uploaded rhythm strip (Lead II) when present */
export function sampleUploadedRhythm(upload: UploadedEkg, tNorm: number): number {
  const series = upload.rhythmSignal;
  if (!series || series.length < 2) {
    const t = ((tNorm % 1) + 1) % 1;
    return sampleLead(upload, "II", t * (upload.signal.length - 1));
  }
  const t = ((tNorm % 1) + 1) % 1;
  const n = series.length;
  const idxF = t * (n - 1);
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
  // Coarse morphology match against uploaded lead voltages (inverse teaching stub)
  const n = upload.signal.length;
  const mid = Math.floor(n * 0.35);
  const win = Math.max(8, Math.floor(n * 0.08));
  let peakI = 0;
  let peakV1 = 0;
  let peakIi = 0;
  let wide = 0;
  let peakSig = 0;
  for (let i = Math.max(0, mid - win); i < Math.min(n, mid + win); i++) {
    peakI = Math.max(peakI, Math.abs(upload.leadSignals.I?.[i] ?? 0));
    peakV1 = Math.max(peakV1, upload.leadSignals.V1?.[i] ?? 0);
    peakIi = Math.max(peakIi, Math.abs(upload.leadSignals.II?.[i] ?? upload.signal[i]!));
    peakSig = Math.max(peakSig, Math.abs(upload.signal[i] ?? 0));
    const dv =
      Math.abs((upload.signal[i] ?? 0) - (upload.signal[Math.max(0, i - 2)] ?? 0));
    if (dv > Math.max(0.06, peakSig * 0.1)) wide++;
  }
  const wideFrac = wide / Math.max(1, win * 2);
  if (upload.rateBpm > 150 && wideFrac > 0.35) return "vt";
  if (upload.rateBpm > 110 && wideFrac < 0.25) return "sinusTachy";
  if (upload.rateBpm < 50) return "sinusBrady";
  // Late positive V1 with modest I → RBBB-ish
  if (peakV1 > Math.max(0.25, peakSig * 0.35) && peakI < peakV1 * 0.85) return "rbbb";
  // Broad QRS without tall V1 R′ → LBBB-ish
  if (wideFrac > 0.4 && peakV1 < Math.max(0.15, peakSig * 0.25)) return "lbbb";
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
