import type { SegmentId } from "./findings";
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
  /** Pixel size of the canvas used when `splitRegions` were measured */
  splitImageSize?: { w: number; h: number };
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
  splitImageSize?: { w: number; h: number };
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
    splitImageSize: opts.splitImageSize,
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
    const calCenters = detectCalibrationPulses(ink, w, h).centers;
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
        const sig = extractBandMv(ink, w, band.y0, band.y1, rx0, rx1, mvPerPx, {
          boxPx,
          baselineHint: calCenters[r],
        });
        shortLeads[id] = sig;
        shortest = Math.min(shortest, sig.length);
        await yieldToUi();
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
      rhythmSignal = extractBandMv(ink, w, rhythm.y0, rhythm.y1, rx0, w, mvPerPx, {
        boxPx,
        baselineHint: calCenters[3],
      });
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
      await yieldToUi();
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
      splitImageSize: { w, h },
      snapshotExact: true,
      rhythmSignal,
    });
  } else if ((bands.length <= 1 && colXs.length < 2) || aspect > 3.4) {
    // Telemetry / single strip
    const y0 = bands[0]?.y0 ?? Math.floor(h * 0.12);
    const y1 = bands[0]?.y1 ?? Math.floor(h * 0.88);
    splitRegions.push({ lead: "II", x0: 0, y0, x1: w, y1 });
    leadSignals.II = extractBandMv(ink, w, y0, y1, 0, w, mvPerPx, boxPx);
  } else {
    // Stacked multi-channel strip without clear columns
    const order: LeadId[] = ["II", "I", "III", "V1", "V2", "V3", "V4", "V5", "V6", "aVR", "aVL", "aVF"];
    for (let i = 0; i < bands.length && i < order.length; i++) {
      const b = bands[i]!;
      const id = order[i]!;
      splitRegions.push({ lead: id, x0: 0, y0: b.y0, x1: w, y1: b.y1 });
      leadSignals[id] = extractBandMv(ink, w, b.y0, b.y1, 0, w, mvPerPx, boxPx);
      await yieldToUi();
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
    splitImageSize: { w, h },
    snapshotExact: classic12,
  });
}

export const UPLOAD_SPLIT_COLORS = [
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

/**
 * Re-extract lead traces from an uploaded image using adjusted crop boxes
 * (same resolution / calibration as the original parse).
 */
export async function reprocessUploadFromRegions(
  upload: UploadedEkg,
  regions: UploadSplitRegion[],
): Promise<UploadedEkg> {
  if (!upload.imageUrl) throw new Error("No image to reprocess");
  if (!regions.length) throw new Error("No lead boxes to extract");

  const img = await loadImage(upload.imageUrl);
  const w = upload.splitImageSize?.w ?? Math.min(1600, img.naturalWidth);
  const h =
    upload.splitImageSize?.h ??
    Math.round((img.naturalHeight / Math.max(1, img.naturalWidth)) * w);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read EKG image");
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const ink = buildInkMask(data, w, h);
  const boxPx = detectLargeBoxPitch(data, w, h) || Math.max(8, Math.round(w / 50));
  const secPerPx = 0.2 / boxPx;
  const mvPerPx = estimateMvPerPx(ink, w, h, boxPx) || 1 / (2 * boxPx);

  const clamped = regions.map((r) => ({
    lead: r.lead,
    x0: Math.max(0, Math.min(w - 2, Math.round(r.x0))),
    y0: Math.max(0, Math.min(h - 2, Math.round(r.y0))),
    x1: Math.max(1, Math.min(w, Math.round(r.x1))),
    y1: Math.max(1, Math.min(h, Math.round(r.y1))),
  }));
  for (const r of clamped) {
    if (r.x1 <= r.x0 + 4) r.x1 = Math.min(w, r.x0 + 8);
    if (r.y1 <= r.y0 + 4) r.y1 = Math.min(h, r.y0 + 8);
  }

  const leadSignals: Partial<Record<LeadId, Float32Array>> = {};
  let rhythmSignal: Float32Array | undefined;
  let gridLenHint = Infinity;
  const calCenters = detectCalibrationPulses(ink, w, h).centers;

  for (const r of clamped) {
    const midY = (r.y0 + r.y1) * 0.5;
    let baselineHint: number | undefined;
    if (calCenters.length) {
      let best = calCenters[0]!;
      let bestD = Math.abs(best - midY);
      for (let i = 1; i < calCenters.length; i++) {
        const c = calCenters[i]!;
        const d = Math.abs(c - midY);
        if (d < bestD) {
          best = c;
          bestD = d;
        }
      }
      if (best >= r.y0 && best < r.y1) baselineHint = best;
    }
    const sig = extractBandMv(ink, w, r.y0, r.y1, r.x0, r.x1, mvPerPx, {
      boxPx,
      baselineHint,
    });
    if (r.lead === "rhythm") {
      rhythmSignal = sig;
    } else {
      leadSignals[r.lead] = sig;
      gridLenHint = Math.min(gridLenHint, sig.length);
    }
    await yieldToUi();
  }

  if (rhythmSignal && !leadSignals.II) {
    const gridLen = Math.max(64, Number.isFinite(gridLenHint) ? gridLenHint : 64);
    if (rhythmSignal.length > gridLen) {
      leadSignals.II = rhythmSignal.slice(
        0,
        Math.min(rhythmSignal.length, Math.round(rhythmSignal.length / 4)),
      );
    } else {
      leadSignals.II = rhythmSignal.slice();
    }
  }

  if (!Object.keys(leadSignals).length) {
    throw new Error("Adjusted boxes did not yield usable lead traces");
  }

  const splitPreviewUrl = renderSplitPreview(canvas, clamped);
  const sampleRateHz = upload.sampleRateHz ?? Math.max(50, Math.round(1 / secPerPx));
  const nLeads = Object.keys(leadSignals).length;
  const snapshotExact = Boolean(rhythmSignal) || nLeads >= 6;

  return finalizeUpload({
    name: upload.name,
    imageUrl: upload.imageUrl,
    leadSignals,
    sourceKind: "image",
    sampleRateHz,
    leadLabels: upload.leadLabels,
    splitPreviewUrl,
    splitRegions: clamped,
    splitImageSize: { w, h },
    snapshotExact,
    rhythmSignal,
  });
}

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
    const color = UPLOAD_SPLIT_COLORS[i % UPLOAD_SPLIT_COLORS.length]!;
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

/**
 * Left-margin 1 mV calibration pulses (Wave-Maven stacks four).
 * Peak-picks row ink, then expands each hit to the pulse body so the center
 * is the baseline (mid-pulse) — not the top plateau where row-sum peaks.
 */
function detectCalibrationPulses(
  ink: Float32Array,
  w: number,
  h: number,
): { centers: number[]; heights: number[] } {
  const x1 = Math.min(w, Math.floor(w * 0.09));
  const row = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 2; x < x1; x++) s += ink[y * w + x]!;
    row[y] = s;
  }
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
  const peakThresh = max * 0.28;
  const bodyThresh = max * 0.16;
  const minSep = h * 0.1;
  const rawPeaks: number[] = [];
  for (let y = Math.floor(h * 0.04); y < Math.floor(h * 0.95); y++) {
    if (sm[y]! < peakThresh) continue;
    if (sm[y]! >= sm[y - 1]! && sm[y]! >= sm[y + 1]!) {
      if (!rawPeaks.length || y - rawPeaks[rawPeaks.length - 1]! > minSep) rawPeaks.push(y);
      else if (sm[y]! > sm[rawPeaks[rawPeaks.length - 1]!]!) rawPeaks[rawPeaks.length - 1] = y;
    }
  }

  const centers: number[] = [];
  const heights: number[] = [];
  // ~2.3 large boxes at typical printout scale — blocks merged multi-row ink
  const maxSpan = Math.max(16, Math.floor(h * 0.09));
  for (const peak of rawPeaks.slice(0, 4)) {
    let y0 = peak;
    let y1 = peak;
    while (y0 > 1 && sm[y0 - 1]! >= bodyThresh) y0--;
    while (y1 < h - 2 && sm[y1 + 1]! >= bodyThresh) y1++;
    if (y1 - y0 + 1 > maxSpan) {
      y0 = Math.max(y0, peak - Math.floor(maxSpan / 2));
      y1 = Math.min(y1, peak + Math.floor(maxSpan / 2));
    }
    const span = y1 - y0 + 1;
    if (span < Math.max(8, h * 0.01)) continue;
    centers.push(Math.floor((y0 + y1) * 0.5));
    heights.push(span);
  }
  return { centers, heights };
}

/** Find ~4 calibration-pulse centers along the left margin. */
function detectCalibrationRowCenters(ink: Float32Array, w: number, h: number): number[] {
  return detectCalibrationPulses(ink, w, h).centers;
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
  const scoreAt = (lag: number): number => {
    let s = 0;
    for (let x = 0; x < w - lag; x += 2) s += proj[x]! * proj[x + lag]!;
    return s;
  };
  // Cap search near ~1–2 expected large boxes. Autocorr often peaks at 2–3×
  // the true pitch (Wave-Maven @1024px: 60 beats 20 by a hair) and that
  // understates 10 mm/mV gain by the same factor.
  const expected = Math.max(10, Math.round(w / 50));
  const minLag = Math.max(6, Math.floor(expected * 0.45));
  const maxLag = Math.min(Math.floor(expected * 2.2), Math.floor(w / 18), 72);
  let bestLag = expected;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const s = scoreAt(lag);
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  // Prefer the fundamental when a near-tied harmonic won (e.g. 60 vs 20)
  let pitch = bestLag;
  for (let k = 2; k <= 4; k++) {
    if (bestLag % k !== 0) continue;
    const sub = bestLag / k;
    if (sub < minLag || sub > maxLag) continue;
    if (scoreAt(sub) >= bestScore * 0.96) pitch = sub;
  }
  // Soft preference for the paper-typical size when scores are close
  if (Math.abs(pitch - expected) > expected * 0.35) {
    const near = Math.max(minLag, Math.min(maxLag, expected));
    if (scoreAt(near) >= bestScore * 0.94) pitch = near;
  }
  // Prefer multiples that look like 5 small boxes; bestLag is often 1 small box
  if (pitch > 0 && pitch < 14) return pitch * 5;
  return pitch;
}

function estimateMvPerPx(ink: Float32Array, w: number, h: number, boxPx: number): number {
  // Standard paper gain: 10 mm = 1 mV = 2 large boxes (from grid pitch)
  const box = Math.max(1, boxPx);
  const stdMvPerPx = 1 / (2 * box);

  // Calibration pulses can refine gain when several agree and clearly differ
  // from the grid estimate (e.g. nonstandard printing). Prefer grid otherwise —
  // single noisy pulse heights (Wave-Maven) skew all amplitudes.
  const { heights } = detectCalibrationPulses(ink, w, h);
  const plausible = heights.filter((span) => span > box * 1.7 && span < box * 2.3);
  if (plausible.length >= 2) {
    const sorted = [...plausible].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)]!;
    if (Math.abs(mid - 2 * box) > box * 0.3) return 1 / mid;
  }

  // Fallback: contiguous ink runs in the far-left columns (rising edges)
  const x1 = Math.min(w, Math.max(8, Math.floor(box * 4)));
  const edgeHeights: number[] = [];
  for (let x = 2; x < x1; x++) {
    let y = 0;
    while (y < h) {
      while (y < h && ink[y * w + x]! <= 40) y++;
      if (y >= h) break;
      const y0 = y;
      while (y < h && ink[y * w + x]! > 40) y++;
      const span = y - y0;
      if (span > box * 1.35 && span < box * 3.2) edgeHeights.push(span);
    }
  }
  if (edgeHeights.length >= 3) {
    edgeHeights.sort((a, b) => a - b);
    const mid = edgeHeights[Math.floor(edgeHeights.length / 2)]!;
    if (mid > box * 1.7 && mid < box * 2.3 && Math.abs(mid - 2 * box) > box * 0.3) {
      return 1 / mid;
    }
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

/**
 * Suppress horizontally persistent ink (isoelectric stroke / grid ghosts) so
 * Viterbi follows QRS spikes instead of riding the baseline highway.
 * Only fills the active search lane for the current crop.
 */
function buildTrackInk(
  ink: Float32Array,
  w: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): Float32Array {
  const out = new Float32Array(ink.length);
  const xL = Math.max(1, x0);
  const xR = Math.min(w - 1, x1);
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = xL; x < xR; x++) {
      const v = ink[row + x]!;
      if (v < 8) continue;
      const l = ink[row + x - 1]!;
      const r = ink[row + x + 1]!;
      out[row + x] = Math.max(0, v - Math.min(l, r) * 0.9);
    }
  }
  return out;
}

function extractBandMv(
  ink: Float32Array,
  w: number,
  y0: number,
  y1: number,
  x0: number,
  x1: number,
  mvPerPx: number,
  opts?: number | { boxPx?: number; baselineHint?: number },
): Float32Array {
  const boxPx =
    typeof opts === "number"
      ? opts
      : (opts?.boxPx ?? 1 / (2 * Math.max(1e-6, mvPerPx)));
  const baselineHint = typeof opts === "number" ? undefined : opts?.baselineHint;
  const xStart = Math.max(0, Math.min(w - 1, x0));
  const xEnd = Math.max(xStart + 1, Math.min(w, x1));
  const width = Math.max(1, xEnd - xStart);
  const hImg = Math.floor(ink.length / w);
  const hCell = Math.max(1, y1 - y0);
  const yCore0 = y0 + Math.max(2, Math.floor(hCell * 0.12));
  const yCore1 = y1 - Math.max(1, Math.floor(hCell * 0.03));
  const box = Math.max(8, boxPx);
  // Allow deep QRS (~±2.5 mV) but do NOT open a lane into the neighboring
  // lead's baseline — expanding the split box used to cause HF chatter as the
  // path oscillated between two stacked traces (classic V1/V2/V3 failure).
  const maxDeflect = Math.max(Math.floor(box * 5), 48);
  const anchorY =
    baselineHint != null && baselineHint >= y0 - box && baselineHint <= y1 + box
      ? baselineHint
      : (y0 + y1) * 0.5;
  const lanePad = Math.max(Math.floor(box * 1.25), 16);
  let lane0 = Math.max(0, Math.max(y0 - lanePad, Math.floor(anchorY - maxDeflect)));
  let lane1 = Math.min(hImg, Math.min(y1 + lanePad, Math.ceil(anchorY + maxDeflect)));
  if (lane1 - lane0 < box * 2) {
    lane0 = Math.max(0, Math.floor(anchorY - maxDeflect));
    lane1 = Math.min(hImg, Math.ceil(anchorY + maxDeflect));
  }
  const H = Math.max(1, lane1 - lane0);
  // Steep QRS can fall ~2 mV in a few pixels; allow that, but make long hops costly.
  const maxStep = Math.max(Math.floor(box * 3), 24);

  const track = buildTrackInk(ink, w, xStart, xEnd, lane0, lane1);

  const INF = 1e12;
  let prevCost = new Float32Array(H);
  let currCost = new Float32Array(H);
  const back = new Int32Array(width * H);
  const outBand = 3.2;

  for (let yi = 0; yi < H; yi++) {
    const y = lane0 + yi;
    const v = track[y * w + xStart]!;
    const band =
      y < yCore0 ? (yCore0 - y) * 0.85 : y >= yCore1 ? (y - (yCore1 - 1)) * 0.85 : 0;
    const anchor = Math.abs(y - anchorY) * 0.08;
    prevCost[yi] = (v < 6 ? 70 : -v * 1.6) + band + anchor;
  }

  for (let xi = 1; xi < width; xi++) {
    const x = xStart + xi;
    currCost.fill(INF);
    for (let yi = 0; yi < H; yi++) {
      const y = lane0 + yi;
      const v = track[y * w + x]!;
      const band =
        y < y0 ? (y0 - y) * outBand : y >= y1 ? (y - (y1 - 1)) * outBand : 0;
      const anchor = Math.abs(y - anchorY) * 0.08;
      const emit = (v < 6 ? 48 : -v * 1.6) + band + anchor;

      const j0 = Math.max(0, yi - maxStep);
      const j1 = Math.min(H - 1, yi + maxStep);
      let best = INF;
      let bestJ = yi;
      for (let j = j0; j <= j1; j++) {
        const step = Math.abs(yi - j);
        // Quadratic-ish cost: cheap for QRS slopes, prohibitive for row hops.
        const trans = step * 0.55 + (step * step) / Math.max(8, box);
        const c = prevCost[j]! + trans;
        if (c < best) {
          best = c;
          bestJ = j;
        }
      }
      currCost[yi] = best + emit;
      back[xi * H + yi] = bestJ;
    }
    const tmp = prevCost;
    prevCost = currCost;
    currCost = tmp;
  }

  let endYi = 0;
  let endBest = INF;
  for (let yi = 0; yi < H; yi++) {
    const y = lane0 + yi;
    const corePen =
      y < yCore0 ? (yCore0 - y) * 0.55 : y >= yCore1 ? (y - (yCore1 - 1)) * 0.55 : 0;
    const c = prevCost[yi]! + corePen + Math.abs(y - anchorY) * 0.05;
    if (c < endBest) {
      endBest = c;
      endYi = yi;
    }
  }

  const ys = new Float32Array(width);
  let yi = endYi;
  for (let xi = width - 1; xi >= 0; xi--) {
    const y = lane0 + yi;
    let sumY = 0;
    let sumW = 0;
    const x = xStart + xi;
    for (let yy = Math.max(lane0, y - 3); yy <= Math.min(lane1 - 1, y + 3); yy++) {
      const v = ink[yy * w + x]!;
      if (v < 8) continue;
      sumY += yy * v;
      sumW += v;
    }
    ys[xi] = sumW > 0 ? sumY / sumW : y;
    if (xi > 0) yi = back[xi * H + yi]!;
  }

  fillGaps(ys);
  despikeTracePath(ys, Math.max(box * 1.8, 20));

  const rowCenterY = (yCore0 + yCore1) * 0.5;
  const flatYs: number[] = [];
  for (let i = 1; i < ys.length - 1; i++) {
    const y = ys[i]!;
    if (!Number.isFinite(y) || y < yCore0 || y >= yCore1) continue;
    const dy = Math.abs(ys[i]! - ys[i - 1]!) + Math.abs(ys[i + 1]! - ys[i]!);
    if (dy < 4) flatYs.push(y);
  }
  // Prefer left-margin calibration pulse center — flat-ink median often locks onto
  // a dark mid-row stroke and shrinks QRS amplitude (Wave-Maven V2/V3).
  let baselineY = rowCenterY;
  if (baselineHint != null && baselineHint >= y0 && baselineHint < y1) {
    baselineY = baselineHint;
  } else if (flatYs.length > 6) {
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

/** Remove single-sample row hops left by competing ink (stacked leads). */
function despikeTracePath(ys: Float32Array, maxJump: number) {
  if (ys.length < 3) return;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < ys.length - 1; i++) {
      const a = ys[i - 1]!;
      const b = ys[i]!;
      const c = ys[i + 1]!;
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) continue;
      const da = Math.abs(b - a);
      const dc = Math.abs(b - c);
      const ac = Math.abs(a - c);
      // Isolated spike toward another row while neighbors agree
      if (da > maxJump && dc > maxJump && ac < maxJump * 0.55) {
        ys[i] = (a + c) * 0.5;
      }
    }
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

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
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
