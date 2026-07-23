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

export type EkgTrace = {
  canvas: HTMLCanvasElement;
  setFinding: (id: FindingId) => void;
  setCycleSec: (sec: number) => void;
  setUpload: (upload: UploadedEkg | null) => void;
  setCustomSample: (fn: ((t: number) => WaveSample) | null) => void;
  /** Wire scrubbing; return false to ignore */
  onScrub: (handler: (deltaSec: number) => void) => void;
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
  let scrubHandler: ((deltaSec: number) => void) | null = null;
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;

  const WINDOW_SEC = 2.5;
  const SAMPLES = 280;
  const buffers: Record<LeadId, Float32Array> = Object.fromEntries(
    LEADS.map((l) => [l, new Float32Array(SAMPLES)]),
  ) as Record<LeadId, Float32Array>;

  function sampleAt(tNorm: number): WaveSample {
    if (upload) return sampleUploaded(upload, tNorm);
    if (customSample) return customSample(tNorm);
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
    findingId = id;
    if (!upload) cycleSec = getFinding(id).cycleSec;
    for (const l of LEADS) buffers[l].fill(0);
  }

  function setCycleSec(sec: number) {
    cycleSec = Math.max(0.25, sec);
  }

  function setUpload(next: UploadedEkg | null) {
    upload = next;
    for (const l of LEADS) buffers[l].fill(0);
  }

  function setCustomSample(fn: ((t: number) => WaveSample) | null) {
    customSample = fn;
    for (const l of LEADS) buffers[l].fill(0);
  }

  function onScrub(handler: (deltaSec: number) => void) {
    scrubHandler = handler;
  }

  // Scrub interactions (pointer + touch)
  let dragging = false;
  let lastX = 0;
  let activePointerId: number | null = null;

  canvas.style.touchAction = "none";

  canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (!e.isPrimary) return;
      e.preventDefault();
      dragging = true;
      activePointerId = e.pointerId;
      lastX = e.clientX;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* older WebViews */
      }
    },
    { passive: false },
  );
  canvas.addEventListener(
    "pointermove",
    (e) => {
      if (!dragging || !scrubHandler) return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      e.preventDefault();
      const dx = e.clientX - lastX;
      lastX = e.clientX;
      // Touch needs more gain — finger travel is short vs strip width
      const gain = e.pointerType === "touch" ? 2.1 : 1;
      const deltaSec = (-dx / Math.max(1, cssW)) * WINDOW_SEC * gain;
      if (dx !== 0) scrubHandler(deltaSec);
    },
    { passive: false },
  );
  const endDrag = (e: PointerEvent) => {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("lostpointercapture", () => {
    dragging = false;
    activePointerId = null;
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!scrubHandler) return;
      e.preventDefault();
      const deltaSec = (e.deltaY / 400) * WINDOW_SEC;
      scrubHandler(deltaSec);
    },
    { passive: false },
  );

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
    opts?: { missing?: boolean; label?: string },
  ) {
    const c = ctx!;
    const buf = buffers[lead];
    const missing = !!opts?.missing;
    const label = opts?.label ?? lead;

    // Standard EKG paper: small 1 mm boxes; every 5th line is a brighter 5 mm box
    // Size so both axes get several large boxes (horizontals were too sparse before)
    const mm = Math.max(3, Math.min(7, Math.round(Math.min(w, h) / 22)));
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
      for (let i = 0; i < SAMPLES; i++) {
        const px = x + (i / (SAMPLES - 1)) * w;
        const py = mid - buf[i]! * amp;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.strokeStyle = GRID.wave;
      c.lineWidth = 1.35;
      c.lineJoin = "round";
      c.stroke();

      const idx = Math.min(
        SAMPLES - 1,
        Math.max(0, Math.round((cursorXLocal / w) * (SAMPLES - 1))),
      );
      const cy = mid - buf[idx]! * amp;

      const glowFrom = Math.max(0, idx - 14);
      const glowTo = Math.min(SAMPLES - 1, idx + 2);
      c.beginPath();
      for (let i = glowFrom; i <= glowTo; i++) {
        const px = x + (i / (SAMPLES - 1)) * w;
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

  function update(elapsedSec: number) {
    const cycle = effectiveCycle();
    const tCycle = ((elapsedSec % cycle) + cycle) % cycle / cycle;
    const sample = sampleAt(tCycle);
    const shown = new Set(displayLeads());

    for (let i = 0; i < SAMPLES; i++) {
      const age = ((SAMPLES - 1 - i) / (SAMPLES - 1)) * WINDOW_SEC;
      const tAbs = elapsedSec - age;
      const tc = ((tAbs % cycle) + cycle) % cycle;
      const s = sampleAt(tc / cycle);
      for (const lead of LEADS) buffers[lead][i] = shown.has(lead) ? s.leads[lead] : 0;
    }

    const c = ctx!;
    c.clearRect(0, 0, cssW, cssH);

    const barH = Math.max(28, Math.min(36, cssH * 0.07));
    drawCycleBar(0, barH, sample.mark);

    const pad = 2;
    const gridTop = barH + 4;
    const layout = upload?.layout ?? "full12";
    const available = displayLeads();
    const labelFor = (lead: LeadId) => upload?.leadLabels?.[lead] ?? lead;
    const rhythmLead = available.includes("II")
      ? "II"
      : available[0] ?? "II";

    // Telemetry / single-channel: one large strip
    if (layout === "telemetry" || available.length === 1) {
      const rhythmH = cssH - gridTop - 4;
      drawLeadCell(rhythmLead, pad, gridTop, cssW - pad * 2, rhythmH, cssW - pad * 2 - 6, {
        label: `${labelFor(rhythmLead)}${layout === "telemetry" ? "  telemetry" : ""}`,
      });
      return { phase: sample.phase, active: sample.active, mark: sample.mark, tCycle, leads: sample.leads };
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
      return { phase: sample.phase, active: sample.active, mark: sample.mark, tCycle, leads: sample.leads };
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
      return { phase: sample.phase, active: sample.active, mark: sample.mark, tCycle, leads: sample.leads };
    }

    // Partial / full12: classic 3×4 with missing leads dimmed; rhythm if II present
    const showRhythm = layout === "full12" || shown.has("II") || available.length >= 6;
    const rhythmH = showRhythm ? Math.max(52, cssH * 0.18) : 0;
    const gridH = cssH - gridTop - rhythmH - 4;
    const colW = (cssW - pad * 2) / 4;
    const rowH = gridH / 3;
    const cursorLocal = colW - 6;

    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 3; row++) {
        const lead = LEAD_GRID[col]![row]!;
        drawLeadCell(lead, pad + col * colW, gridTop + row * rowH, colW, rowH, cursorLocal, {
          missing: upload ? !shown.has(lead) : false,
        });
      }
    }

    if (showRhythm) {
      const ry = gridTop + gridH + 2;
      drawLeadCell(rhythmLead, pad, ry, cssW - pad * 2, rhythmH - 2, cssW - pad * 2 - 6);
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

    return { phase: sample.phase, active: sample.active, mark: sample.mark, tCycle, leads: sample.leads };
  }

  resize();

  return {
    canvas,
    setFinding,
    setCycleSec,
    setUpload,
    setCustomSample,
    onScrub,
    update,
    resize,
    getWindowSec: () => WINDOW_SEC,
  };
}
