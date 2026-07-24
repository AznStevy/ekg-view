import type { FindingId } from "./findings";
import { getFinding } from "./findings";
import {
  CYCLE_MARKS,
  LEAD_GRID,
  LEADS,
  sampleWave,
  type CycleMark,
  type LeadId,
  type WaveSample,
} from "./ekgWaveforms";
import { sampleUploaded, type UploadedEkg } from "./ekgUpload";

const GRID = {
  /** 1 mm small boxes */
  small: "rgba(61, 184, 200, 0.11)",
  /** 5 mm large boxes */
  large: "rgba(61, 184, 200, 0.38)",
  baseline: "rgba(138, 160, 174, 0.28)",
  wave: "#3db8c8",
  label: "#8aa0ae",
  panelLine: "rgba(94, 160, 180, 0.22)",
};

const MARK_COLORS: Record<CycleMark, { idle: string; active: string; text: string }> = {
  P: { idle: "rgba(240, 192, 64, 0.12)", active: "rgba(240, 192, 64, 0.55)", text: "#f0c040" },
  PR: { idle: "rgba(255, 122, 74, 0.1)", active: "rgba(255, 122, 74, 0.5)", text: "#ff9a6a" },
  QRS: { idle: "rgba(61, 184, 200, 0.12)", active: "rgba(61, 184, 200, 0.6)", text: "#3db8c8" },
  ST: { idle: "rgba(110, 200, 150, 0.1)", active: "rgba(110, 200, 150, 0.5)", text: "#6ec896" },
  T: { idle: "rgba(126, 160, 255, 0.1)", active: "rgba(126, 160, 255, 0.5)", text: "#8eb0ff" },
  TP: { idle: "rgba(138, 160, 174, 0.08)", active: "rgba(138, 160, 174, 0.35)", text: "#8aa0ae" },
};

export type CustomSampleOpts = {
  /**
   * When true, `fn` receives absolute elapsed seconds and the rolling window is
   * sampled without cycle-wrapping (so one-shot arcs like cardioversion stay continuous).
   */
  absolute?: boolean;
  /** Conduction / phase-bar progress when using absolute sampling. */
  tCycleAt?: (elapsedSec: number) => number;
  /** Keep the current strip pixels; next update will rewrite from the sampler. */
  preserveTrace?: boolean;
};

export type CalipersState = {
  enabled: boolean;
  /** Window fraction 0…1 (left = older) */
  x0: number | null;
  x1: number | null;
  march: boolean;
};

export type CalipersReadout = {
  intervalSec: number;
  intervalMs: number;
  bpm: number;
};

export type EkgTrace = {
  canvas: HTMLCanvasElement;
  setFinding: (id: FindingId) => void;
  setCycleSec: (sec: number) => void;
  setUpload: (upload: UploadedEkg | null) => void;
  setCustomSample: (fn: ((t: number) => WaveSample) | null, opts?: CustomSampleOpts) => void;
  /** Wire scrubbing; return false to ignore */
  onScrub: (handler: (deltaSec: number) => void) => void;
  setCalipersEnabled: (on: boolean) => void;
  setCalipersMarch: (on: boolean) => void;
  clearCalipers: () => void;
  getCalipers: () => CalipersState;
  getCalipersReadout: () => CalipersReadout | null;
  onCalipersChange: (handler: (readout: CalipersReadout | null) => void) => void;
  update: (elapsedSec: number) => Pick<WaveSample, "phase" | "active" | "mark" | "leads"> & { tCycle: number };
  resize: () => void;
  getWindowSec: () => number;
};

export function createEkgTrace(host: HTMLElement): EkgTrace {
  const canvas = document.createElement("canvas");
  canvas.className = "ekg-canvas";
  canvas.style.cursor = "ew-resize";
  canvas.title = "Drag or swipe to scrub the EKG";
  host.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");

  let findingId: FindingId = "nsr";
  let cycleSec = getFinding("nsr").cycleSec;
  let upload: UploadedEkg | null = null;
  let customSample: ((t: number) => WaveSample) | null = null;
  let customAbsolute = false;
  let customTCycleAt: ((elapsedSec: number) => number) | null = null;
  let scrubHandler: ((deltaSec: number) => void) | null = null;
  let calipersHandler: ((readout: CalipersReadout | null) => void) | null = null;
  let calipers: CalipersState = { enabled: false, x0: null, x1: null, march: false };
  let caliperDragging = false;
  let caliperDragWhich: "x0" | "x1" | "new" | null = null;
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  /** Top of waveform area (below cycle bar) — calipers span from here down */
  let caliperTop = 0;
  /**
   * Time span currently represented across the rhythm / full-width strip.
   * Grid lead cells show only the most recent COLUMN_WINDOW_SEC of this buffer
   * so paper speed matches the bottom Lead II strip.
   */
  let viewWindowSec = 2.5;
  /** Pixels per 1 mm (small box). Large box = 5 mm = 0.2 s at standard speed. */
  let paperMmPx = 4;

  /** Standard ECG: 25 mm/s → one large box (5 mm) = 0.2 s */
  const LARGE_BOX_SEC = 0.2;
  const SMALL_PER_LARGE = 5;
  /** Seconds shown in one 12-lead grid column (12.5 large boxes) */
  const COLUMN_WINDOW_SEC = 2.5;
  /** Full12 rhythm strip = 4 columns wide → 4× the column window */
  const GRID_COLS = 4;
  const MAX_WINDOW_SEC = COLUMN_WINDOW_SEC * GRID_COLS;
  /**
   * Samples across the longest (rhythm) window.
   * Keep SAMPLES×SUBSAMPLE near the old 360×8 budget so complex rhythms don't stall the UI.
   */
  const SAMPLES = 180 * GRID_COLS;
  const SUBSAMPLE = 4;
  const buffers: Record<LeadId, Float32Array> = Object.fromEntries(
    LEADS.map((l) => [l, new Float32Array(SAMPLES)]),
  ) as Record<LeadId, Float32Array>;

  function sampleAt(tNorm: number, tAbs?: number): WaveSample {
    if (upload) return sampleUploaded(upload, tNorm);
    if (customSample) {
      if (customAbsolute) return customSample(tAbs ?? tNorm * cycleSec);
      return customSample(tNorm);
    }
    return sampleWave(findingId, tNorm);
  }

  function effectiveCycle(): number {
    if (upload) return Math.max(0.5, upload.durationSec);
    return Math.max(0.25, cycleSec);
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function setFinding(id: FindingId) {
    const changed = findingId !== id;
    findingId = id;
    if (!upload) cycleSec = getFinding(id).cycleSec;
    if (changed) {
      for (const l of LEADS) buffers[l].fill(0);
    }
  }

  function setCycleSec(sec: number) {
    cycleSec = Math.max(0.25, sec);
  }

  function setUpload(next: UploadedEkg | null) {
    upload = next;
    for (const l of LEADS) buffers[l].fill(0);
  }

  function setCustomSample(fn: ((t: number) => WaveSample) | null, opts?: CustomSampleOpts) {
    customSample = fn;
    customAbsolute = !!fn && !!opts?.absolute;
    customTCycleAt = fn && opts?.absolute ? (opts.tCycleAt ?? null) : null;
    if (!opts?.preserveTrace) {
      for (const l of LEADS) buffers[l].fill(0);
    }
  }

  function onScrub(handler: (deltaSec: number) => void) {
    scrubHandler = handler;
  }

  function onCalipersChange(handler: (readout: CalipersReadout | null) => void) {
    calipersHandler = handler;
  }

  function getCalipers(): CalipersState {
    return { ...calipers };
  }

  function getCalipersReadout(): CalipersReadout | null {
    if (calipers.x0 == null || calipers.x1 == null) return null;
    // Measure in paper mm so 1 large box (5 small) = LARGE_BOX_SEC
    const dxPx = Math.abs(calipers.x1 - calipers.x0) * cssW;
    const largeBoxes = dxPx / Math.max(1e-6, paperMmPx * SMALL_PER_LARGE);
    const intervalSec = largeBoxes * LARGE_BOX_SEC;
    if (intervalSec < 0.01) return null;
    return {
      intervalSec,
      intervalMs: Math.round(intervalSec * 1000),
      bpm: Math.round(60 / intervalSec),
    };
  }

  function notifyCalipers() {
    calipersHandler?.(getCalipersReadout());
  }

  function setCalipersEnabled(on: boolean) {
    calipers.enabled = on;
    if (!on) {
      calipers.x0 = null;
      calipers.x1 = null;
      caliperDragging = false;
      caliperDragWhich = null;
    }
    canvas.style.cursor = on ? "crosshair" : "ew-resize";
    canvas.title = on
      ? "Drag to set caliper interval · wheel still scrubs"
      : "Drag or swipe to scrub the EKG";
    notifyCalipers();
  }

  function setCalipersMarch(on: boolean) {
    calipers.march = on;
  }

  function clearCalipers() {
    calipers.x0 = null;
    calipers.x1 = null;
    caliperDragging = false;
    caliperDragWhich = null;
    notifyCalipers();
  }

  function clientXToFrac(clientX: number): number {
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  }

  function nearestCaliperHandle(frac: number): "x0" | "x1" | null {
    const hit = 0.02;
    let best: "x0" | "x1" | null = null;
    let bestD = hit;
    if (calipers.x0 != null) {
      const d = Math.abs(frac - calipers.x0);
      if (d < bestD) {
        bestD = d;
        best = "x0";
      }
    }
    if (calipers.x1 != null) {
      const d = Math.abs(frac - calipers.x1);
      if (d < bestD) {
        bestD = d;
        best = "x1";
      }
    }
    return best;
  }

  // Scrub / caliper interactions
  let dragging = false;
  let lastX = 0;
  let activePointerId: number | null = null;

  canvas.style.touchAction = "none";

  canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isPrimary) return;
      e.preventDefault();
      activePointerId = e.pointerId;
      lastX = e.clientX;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* older WebViews */
      }

      if (calipers.enabled) {
        const frac = clientXToFrac(e.clientX);
        const handle = nearestCaliperHandle(frac);
        caliperDragging = true;
        if (handle) {
          caliperDragWhich = handle;
        } else {
          caliperDragWhich = "new";
          calipers.x0 = frac;
          calipers.x1 = frac;
          notifyCalipers();
        }
        return;
      }

      dragging = true;
    },
    { passive: false },
  );
  canvas.addEventListener(
    "pointermove",
    (e) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;

      if (calipers.enabled && caliperDragging) {
        e.preventDefault();
        const frac = clientXToFrac(e.clientX);
        if (caliperDragWhich === "x0") calipers.x0 = frac;
        else if (caliperDragWhich === "x1") calipers.x1 = frac;
        else if (caliperDragWhich === "new") calipers.x1 = frac;
        notifyCalipers();
        return;
      }

      if (!dragging || !scrubHandler) return;
      e.preventDefault();
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      const gain = e.pointerType === "touch" ? 2.1 : 1;
      const pxPerSec = (paperMmPx * SMALL_PER_LARGE) / LARGE_BOX_SEC;
      const deltaSec = (-dx / Math.max(1, pxPerSec)) * gain;
      if (dx !== 0) scrubHandler(deltaSec);
    },
    { passive: false },
  );
  const endDrag = (e: PointerEvent) => {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    dragging = false;
    caliperDragging = false;
    caliperDragWhich = null;
    activePointerId = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("lostpointercapture", () => {
    dragging = false;
    caliperDragging = false;
    caliperDragWhich = null;
    activePointerId = null;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!scrubHandler) return;
      e.preventDefault();
      const pxPerSec = (paperMmPx * SMALL_PER_LARGE) / LARGE_BOX_SEC;
      const deltaSec = (e.deltaY / 400) * (cssW / Math.max(1, pxPerSec));
      scrubHandler(deltaSec);
    },
    { passive: false },
  );

  function drawCalipers(top: number) {
    if (!calipers.enabled) return;
    const c = ctx!;
    const bottom = cssH;
    const xs: { x: number; primary: boolean }[] = [];

    if (calipers.x0 != null) xs.push({ x: calipers.x0, primary: true });
    if (calipers.x1 != null) xs.push({ x: calipers.x1, primary: true });

    if (calipers.march && calipers.x0 != null && calipers.x1 != null) {
      const step = Math.abs(calipers.x1 - calipers.x0);
      if (step > 0.008) {
        const a = Math.min(calipers.x0, calipers.x1);
        for (let k = -24; k <= 48; k++) {
          const xx = a + k * step;
          if (xx < -0.02 || xx > 1.02) continue;
          if (Math.abs(xx - calipers.x0) < 1e-4 || Math.abs(xx - calipers.x1) < 1e-4) continue;
          xs.push({ x: xx, primary: false });
        }
      }
    }

    for (const { x: frac, primary } of xs) {
      const px = frac * cssW;
      c.strokeStyle = primary ? "rgba(240, 192, 64, 0.9)" : "rgba(240, 192, 64, 0.35)";
      c.lineWidth = primary ? 1.5 : 1;
      c.setLineDash(primary ? [] : [3, 4]);
      c.beginPath();
      c.moveTo(px + 0.5, top);
      c.lineTo(px + 0.5, bottom);
      c.stroke();
      c.setLineDash([]);
      if (primary) {
        c.fillStyle = "rgba(240, 192, 64, 0.95)";
        c.beginPath();
        c.moveTo(px, top);
        c.lineTo(px - 4, top + 7);
        c.lineTo(px + 4, top + 7);
        c.closePath();
        c.fill();
      }
    }

    const readout = getCalipersReadout();
    if (readout && calipers.x0 != null && calipers.x1 != null) {
      const mid = ((calipers.x0 + calipers.x1) / 2) * cssW;
      const label = `${readout.intervalMs} ms · ${readout.bpm} /min`;
      c.font = '600 11px "IBM Plex Mono", monospace';
      const tw = c.measureText(label).width;
      const lx = Math.max(6, Math.min(cssW - tw - 10, mid - tw / 2));
      const ly = top + 10;
      c.fillStyle = "rgba(8, 14, 18, 0.78)";
      roundRect(c, lx - 4, ly - 2, tw + 8, 16, 4);
      c.fill();
      c.fillStyle = "#f0c040";
      c.textAlign = "left";
      c.textBaseline = "top";
      c.fillText(label, lx, ly);
    }
  }

  function finishFrame(
    sample: WaveSample,
    tCycle: number,
  ): Pick<WaveSample, "phase" | "active" | "mark" | "leads"> & { tCycle: number } {
    drawCalipers(caliperTop);
    return { phase: sample.phase, active: sample.active, mark: sample.mark, tCycle, leads: sample.leads };
  }

  function drawCycleBar(y: number, h: number, active: CycleMark) {
    const c = ctx!;
    const pad = 4;
    const n = CYCLE_MARKS.length;
    const gap = 3;
    const cellW = (cssW - pad * 2 - gap * (n - 1)) / n;

    c.fillStyle = "rgba(8, 14, 18, 0.55)";
    c.fillRect(0, y, cssW, h);

    CYCLE_MARKS.forEach((m, i) => {
      const x = pad + i * (cellW + gap);
      const on = m.id === active;
      const colors = MARK_COLORS[m.id];
      c.fillStyle = on ? colors.active : colors.idle;
      roundRect(c, x, y + 4, cellW, h - 8, 5);
      c.fill();

      if (on) {
        c.strokeStyle = colors.text;
        c.lineWidth = 1.5;
        c.stroke();
        c.shadowColor = colors.text;
        c.shadowBlur = 10;
        c.stroke();
        c.shadowBlur = 0;
      }

      c.fillStyle = on ? "#0a1218" : colors.text;
      c.font = `600 ${Math.max(10, Math.min(13, h * 0.38))}px "IBM Plex Mono", monospace`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(m.label, x + cellW / 2, y + h / 2 + 0.5);
    });
  }

  function roundRect(
    c: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function drawLeadCell(
    lead: LeadId,
    x: number,
    y: number,
    w: number,
    h: number,
    cursorXLocal: number,
    opts?: { missing?: boolean; label?: string; fromFrac?: number; toFrac?: number },
  ) {
    const c = ctx!;
    const buf = buffers[lead];
    const missing = !!opts?.missing;
    const label = opts?.label ?? lead;
    const fromFrac = Math.max(0, Math.min(1, opts?.fromFrac ?? 0));
    const toFrac = Math.max(fromFrac + 1e-6, Math.min(1, opts?.toFrac ?? 1));
    const i0 = Math.round(fromFrac * (SAMPLES - 1));
    const i1 = Math.round(toFrac * (SAMPLES - 1));
    const span = Math.max(1, i1 - i0);

    // Square paper boxes: 1 mm small, 5 mm large (= 0.2 s horizontally)
    const mm = paperMmPx;
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();

    if (missing) {
      c.fillStyle = "rgba(8, 14, 18, 0.55)";
      c.fillRect(x, y, w, h);
    }

    const drawGrid = (major: boolean) => {
      c.strokeStyle = major ? GRID.large : GRID.small;
      c.lineWidth = major ? 1.25 : 1;
      // Vertical
      for (let i = 0; ; i++) {
        const gx = x + i * mm;
        if (gx > x + w + 0.5) break;
        if ((i % 5 === 0) !== major) continue;
        c.beginPath();
        c.moveTo(Math.floor(gx) + 0.5, y);
        c.lineTo(Math.floor(gx) + 0.5, y + h);
        c.stroke();
      }
      // Horizontal
      for (let i = 0; ; i++) {
        const gy = y + i * mm;
        if (gy > y + h + 0.5) break;
        if ((i % 5 === 0) !== major) continue;
        c.beginPath();
        c.moveTo(x, Math.floor(gy) + 0.5);
        c.lineTo(x + w, Math.floor(gy) + 0.5);
        c.stroke();
      }
    };
    drawGrid(false);
    drawGrid(true);

    const mid = y + h * 0.55;
    const amp = h * 0.32;
    c.strokeStyle = GRID.baseline;
    c.beginPath();
    c.moveTo(x, mid);
    c.lineTo(x + w, mid);
    c.stroke();

    if (!missing) {
      const cx = x + cursorXLocal;
      c.fillStyle = "rgba(240, 192, 64, 0.06)";
      c.fillRect(cx - 3, y, 6, h);

      c.beginPath();
      for (let i = i0; i <= i1; i++) {
        const px = x + ((i - i0) / span) * w;
        const py = mid - buf[i]! * amp;
        if (i === i0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.strokeStyle = GRID.wave;
      c.lineWidth = 1.5;
      c.lineJoin = "round";
      c.lineCap = "round";
      c.stroke();

      const idx = Math.min(i1, Math.max(i0, i0 + Math.round((cursorXLocal / w) * span)));
      const cy = mid - buf[idx]! * amp;

      const glowFrom = Math.max(i0, idx - 14);
      const glowTo = Math.min(i1, idx + 2);
      c.beginPath();
      for (let i = glowFrom; i <= glowTo; i++) {
        const px = x + ((i - i0) / span) * w;
        const py = mid - buf[i]! * amp;
        if (i === glowFrom) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.strokeStyle = "rgba(230, 248, 255, 0.95)";
      c.lineWidth = 2.4;
      c.lineJoin = "round";
      c.lineCap = "round";
      c.shadowColor = "#3db8c8";
      c.shadowBlur = 8;
      c.stroke();
      c.shadowBlur = 0;

      c.strokeStyle = "rgba(240, 192, 64, 0.35)";
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(cx + 0.5, y);
      c.lineTo(cx + 0.5, y + h);
      c.stroke();

      c.fillStyle = "rgba(240, 192, 64, 0.35)";
      c.beginPath();
      c.arc(cx, cy, 7, 0, Math.PI * 2);
      c.fill();

      c.fillStyle = "#fff6d0";
      c.shadowColor = "#f0c040";
      c.shadowBlur = 12;
      c.beginPath();
      c.arc(cx, cy, 3.6, 0, Math.PI * 2);
      c.fill();
      c.shadowBlur = 0;

      c.fillStyle = "#ffffff";
      c.beginPath();
      c.arc(cx, cy, 1.6, 0, Math.PI * 2);
      c.fill();
    }

    c.fillStyle = missing ? "rgba(138, 160, 174, 0.55)" : GRID.label;
    c.font = '600 11px "IBM Plex Mono", monospace';
    c.textAlign = "left";
    c.textBaseline = "top";
    c.fillText(missing ? `${label} · —` : label, x + 6, y + 5);

    c.restore();

    c.strokeStyle = GRID.panelLine;
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function displayLeads(): LeadId[] {
    if (!upload) return [...LEADS];
    return upload.availableLeads.length ? [...upload.availableLeads] : [...LEADS];
  }

  function sampleNormAt(tAbs: number, cycle: number): WaveSample {
    if (customAbsolute) return sampleAt(0, tAbs);
    const tc = ((tAbs % cycle) + cycle) % cycle;
    return sampleAt(tc / cycle, tAbs);
  }

  function update(elapsedSec: number) {
    const cycle = effectiveCycle();
    const tCycle =
      customAbsolute && customTCycleAt
        ? ((customTCycleAt(elapsedSec) % 1) + 1) % 1
        : (((elapsedSec % cycle) + cycle) % cycle) / cycle;
    const sample = sampleAt(tCycle, elapsedSec);
    const shown = new Set(displayLeads());
    const layout = upload?.layout ?? "full12";
    const available = displayLeads();
    const labelFor = (lead: LeadId) => upload?.leadLabels?.[lead] ?? lead;
    const rhythmLead = available.includes("II")
      ? "II"
      : available[0] ?? "II";

    // Match classic paper: grid cells = 1 column window; rhythm strip = full width at same speed
    const isSingleOrPair =
      layout === "telemetry" ||
      available.length === 1 ||
      layout === "rhythm" ||
      available.length === 2;
    const isSixPack = layout === "limb6" || layout === "precordial6";
    const showRhythmStrip =
      !isSingleOrPair &&
      !isSixPack &&
      (layout === "full12" || shown.has("II") || available.length >= 6);
    viewWindowSec = showRhythmStrip ? MAX_WINDOW_SEC : COLUMN_WINDOW_SEC;
    const gridFromFrac = showRhythmStrip ? 1 - COLUMN_WINDOW_SEC / viewWindowSec : 0;

    const pad = 2;
    const traceW = Math.max(1, cssW - pad * 2);
    // Size small boxes so the full-width strip's time span is exact on paper
    // (1 large box = 5 small = LARGE_BOX_SEC).
    const largeBoxesAcross = viewWindowSec / LARGE_BOX_SEC;
    paperMmPx = traceW / (largeBoxesAcross * SMALL_PER_LARGE);

    const dtBin = viewWindowSec / Math.max(1, SAMPLES - 1);

    // Peak-hold each display column so needle-thin QRS don't alias to random heights
    for (const lead of LEADS) buffers[lead].fill(0);
    for (let i = 0; i < SAMPLES; i++) {
      const ageCenter = ((SAMPLES - 1 - i) / (SAMPLES - 1)) * viewWindowSec;
      for (let s = 0; s < SUBSAMPLE; s++) {
        const frac = (s + 0.5) / SUBSAMPLE;
        const age = ageCenter + (frac - 0.5) * dtBin;
        const tAbs = elapsedSec - age;
        const smp = sampleNormAt(tAbs, cycle);
        for (const lead of LEADS) {
          if (!shown.has(lead)) continue;
          const v = smp.leads[lead]!;
          if (Math.abs(v) >= Math.abs(buffers[lead][i]!)) buffers[lead][i] = v;
        }
      }
    }

    const c = ctx!;
    c.clearRect(0, 0, cssW, cssH);

    const barH = Math.max(28, Math.min(36, cssH * 0.07));
    drawCycleBar(0, barH, sample.mark);

    const gridTop = barH + 4;
    caliperTop = gridTop;

    // Telemetry / single-channel: one large strip
    if (layout === "telemetry" || available.length === 1) {
      const rhythmH = cssH - gridTop - 4;
      drawLeadCell(rhythmLead, pad, gridTop, cssW - pad * 2, rhythmH, cssW - pad * 2 - 6, {
        label: `${labelFor(rhythmLead)}${layout === "telemetry" ? "  telemetry" : ""}`,
      });
      return finishFrame(sample, tCycle);
    }

    // Rhythm-only pair: stacked full-width strips
    if (layout === "rhythm" || available.length === 2) {
      const rowH = (cssH - gridTop - 4) / available.length;
      available.forEach((lead, i) => {
        drawLeadCell(
          lead,
          pad,
          gridTop + i * rowH,
          cssW - pad * 2,
          rowH - 2,
          cssW - pad * 2 - 6,
          { label: labelFor(lead) },
        );
      });
      return finishFrame(sample, tCycle);
    }

    // 6-lead packs
    if (layout === "limb6" || layout === "precordial6") {
      const cols = 3;
      const rows = 2;
      const gridH = cssH - gridTop - 4;
      const colW = (cssW - pad * 2) / cols;
      const rowH = gridH / rows;
      const pack =
        layout === "limb6"
          ? (["I", "II", "III", "aVR", "aVL", "aVF"] as LeadId[])
          : (["V1", "V2", "V3", "V4", "V5", "V6"] as LeadId[]);
      pack.forEach((lead, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        drawLeadCell(
          lead,
          pad + col * colW,
          gridTop + row * rowH,
          colW,
          rowH,
          colW - 6,
          { missing: !shown.has(lead) },
        );
      });
      return finishFrame(sample, tCycle);
    }

    // Partial / full12: classic 3×4 with missing leads dimmed; rhythm if II present
    const showRhythm = showRhythmStrip;
    const rhythmH = showRhythm ? Math.max(52, cssH * 0.18) : 0;
    const gridH = cssH - gridTop - rhythmH - 4;
    const colW = (cssW - pad * 2) / GRID_COLS;
    const rowH = gridH / 3;
    const cursorLocal = colW - 6;

    for (let col = 0; col < GRID_COLS; col++) {
      for (let row = 0; row < 3; row++) {
        const lead = LEAD_GRID[col]![row]!;
        drawLeadCell(lead, pad + col * colW, gridTop + row * rowH, colW, rowH, cursorLocal, {
          missing: upload ? !shown.has(lead) : false,
          fromFrac: gridFromFrac,
          toFrac: 1,
        });
      }
    }

    if (showRhythm) {
      const ry = gridTop + gridH + 2;
      drawLeadCell(rhythmLead, pad, ry, cssW - pad * 2, rhythmH - 2, cssW - pad * 2 - 6, {
        fromFrac: 0,
        toFrac: 1,
      });
      c.fillStyle = "#3db8c8";
      c.font = '600 10px "IBM Plex Mono", monospace';
      c.textAlign = "left";
      c.textBaseline = "top";
      const tag = upload
        ? `${rhythmLead}  uploaded`
        : customSample
          ? `${rhythmLead}  stimulated`
          : `${rhythmLead}  rhythm`;
      c.fillText(tag, pad + 6, ry + 5);
    }

    return finishFrame(sample, tCycle);
  }

  resize();

  return {
    canvas,
    setFinding,
    setCycleSec,
    setUpload,
    setCustomSample,
    onScrub,
    setCalipersEnabled,
    setCalipersMarch,
    clearCalipers,
    getCalipers,
    getCalipersReadout,
    onCalipersChange,
    update,
    resize,
    getWindowSec: () => viewWindowSec,
  };
}
