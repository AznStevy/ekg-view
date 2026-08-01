import {
  UPLOAD_SPLIT_COLORS,
  type UploadSplitRegion,
} from "./ekgUpload";

type DragMode =
  | { kind: "move"; index: number; startX: number; startY: number; orig: UploadSplitRegion }
  | {
      kind: "resize";
      index: number;
      handle: string;
      startX: number;
      startY: number;
      orig: UploadSplitRegion;
    };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

export type SplitEditorHost = {
  stage: HTMLElement;
  overlay: HTMLElement;
  toolbar: HTMLElement;
  img: HTMLImageElement;
};

/**
 * Interactive lead crop boxes over the uploaded EKG image.
 * Coordinates match `splitImageSize` / `UploadSplitRegion` space.
 */
export function createSplitEditor(host: SplitEditorHost) {
  let regions: UploadSplitRegion[] = [];
  let imgW = 1;
  let imgH = 1;
  let drag: DragMode | null = null;
  let active = false;

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return;
    e.preventDefault();
    const scale = displayScale();
    if (!scale) return;
    const dx = (e.clientX - drag.startX) / scale.sx;
    const dy = (e.clientY - drag.startY) / scale.sy;
    const o = drag.orig;
    let next: UploadSplitRegion = { ...o };

    if (drag.kind === "move") {
      const bw = o.x1 - o.x0;
      const bh = o.y1 - o.y0;
      let x0 = o.x0 + dx;
      let y0 = o.y0 + dy;
      x0 = Math.max(0, Math.min(imgW - bw, x0));
      y0 = Math.max(0, Math.min(imgH - bh, y0));
      next = { ...o, x0, y0, x1: x0 + bw, y1: y0 + bh };
    } else {
      const h = drag.handle;
      let { x0, y0, x1, y1 } = o;
      if (h.includes("w")) x0 = o.x0 + dx;
      if (h.includes("e")) x1 = o.x1 + dx;
      if (h.includes("n")) y0 = o.y0 + dy;
      if (h.includes("s")) y1 = o.y1 + dy;
      const min = 12;
      if (x1 - x0 < min) {
        if (h.includes("w")) x0 = x1 - min;
        else x1 = x0 + min;
      }
      if (y1 - y0 < min) {
        if (h.includes("n")) y0 = y1 - min;
        else y1 = y0 + min;
      }
      x0 = Math.max(0, Math.min(imgW - min, x0));
      y0 = Math.max(0, Math.min(imgH - min, y0));
      x1 = Math.max(x0 + min, Math.min(imgW, x1));
      y1 = Math.max(y0 + min, Math.min(imgH, y1));
      next = { ...o, x0, y0, x1, y1 };
    }
    regions[drag.index] = next;
    paintBox(drag.index);
  };

  const onPointerUp = () => {
    if (!drag) return;
    drag = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  };

  function displayScale(): { sx: number; sy: number } | null {
    const rect = host.img.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    return { sx: rect.width / imgW, sy: rect.height / imgH };
  }

  function paintBox(i: number) {
    const el = host.overlay.children[i] as HTMLElement | undefined;
    const r = regions[i];
    if (!el || !r) return;
    el.style.left = `${(r.x0 / imgW) * 100}%`;
    el.style.top = `${(r.y0 / imgH) * 100}%`;
    el.style.width = `${((r.x1 - r.x0) / imgW) * 100}%`;
    el.style.height = `${((r.y1 - r.y0) / imgH) * 100}%`;
  }

  function rebuildDom() {
    host.overlay.replaceChildren();
    regions.forEach((r, i) => {
      const color = UPLOAD_SPLIT_COLORS[i % UPLOAD_SPLIT_COLORS.length]!;
      const box = document.createElement("div");
      box.className = "upload-split-box";
      box.style.borderColor = color;
      box.dataset.index = String(i);

      const label = document.createElement("span");
      label.className = "upload-split-box-label";
      label.style.background = "rgba(0,0,0,0.55)";
      label.style.color = color;
      label.textContent = r.lead === "rhythm" ? "II rhythm" : r.lead;
      box.appendChild(label);

      for (const h of HANDLES) {
        const handle = document.createElement("div");
        handle.className = `upload-split-handle upload-split-handle-${h}`;
        handle.dataset.handle = h;
        handle.addEventListener("pointerdown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const idx = i;
          drag = {
            kind: "resize",
            index: idx,
            handle: h,
            startX: e.clientX,
            startY: e.clientY,
            orig: { ...regions[idx]! },
          };
          window.addEventListener("pointermove", onPointerMove);
          window.addEventListener("pointerup", onPointerUp);
        });
        box.appendChild(handle);
      }

      box.addEventListener("pointerdown", (e) => {
        if ((e.target as HTMLElement).dataset.handle) return;
        e.preventDefault();
        drag = {
          kind: "move",
          index: i,
          startX: e.clientX,
          startY: e.clientY,
          orig: { ...regions[i]! },
        };
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
      });

      host.overlay.appendChild(box);
      paintBox(i);
    });
  }

  function set(
    next: UploadSplitRegion[],
    size: { w: number; h: number },
  ) {
    regions = next.map((r) => ({ ...r }));
    imgW = Math.max(1, size.w);
    imgH = Math.max(1, size.h);
    rebuildDom();
  }

  function show(on: boolean) {
    active = on;
    host.overlay.hidden = !on;
    host.toolbar.hidden = !on;
    host.stage.classList.toggle("is-editing", on);
  }

  function getRegions(): UploadSplitRegion[] {
    return regions.map((r) => ({ ...r }));
  }

  function isActive() {
    return active;
  }

  function destroy() {
    onPointerUp();
    host.overlay.replaceChildren();
    show(false);
  }

  return { set, show, getRegions, isActive, destroy, paintAll: () => regions.forEach((_, i) => paintBox(i)) };
}

export type SplitEditor = ReturnType<typeof createSplitEditor>;
