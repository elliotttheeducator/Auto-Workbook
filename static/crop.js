// Interactive manual-crop tool - a safety valve for the rare case an
// automated crop rect ran a bit too generous (trim_whitespace in
// add_chapter.py only trims blank margin, not unwanted real content) or
// included something that shouldn't be there at all. Draws a movable,
// resizable selection rectangle over whatever's currently showing for a
// block/group, and on Apply, extracts just that sub-region into a new
// PNG (via an offscreen canvas) that replaces the image from then on -
// a real pixel crop, not a CSS clip, so it behaves exactly like any
// other crop everywhere else in the app (pagination measurement, print
// export, the diagram-scale control) with no special-casing needed.

const HANDLE_SIZE = 12;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Resolves with { dataUrl, rect } for the newly-cropped PNG (rect is
// the selection actually used, in the same 0-100% shape as
// initialRect, so the caller can offer it back next time), the string
// "RESET" if the user asked to go back to the original crop, or null if
// cancelled - the caller decides what each of those means for the
// block/group's own override.
//
// imgSrc should always be the original, full-resolution crop - never
// an already-cropped result. This tool can only ever select a
// sub-region of whatever image it's given; if it were ever pointed at
// an already-cropped PNG, there would be no way for a later re-crop to
// recover the pixels that first crop left out, forcing a full "Reset
// to original" (losing the crop entirely) just to grow the selection
// back out a little. Loading the true original every time and passing
// the previously saved selection as initialRect instead gets the same
// "start from where I left off" feel with none of that dead end - the
// box opens right back where the user left it, over the full image, so
// dragging it back out in any direction always works.
export function openCropModal(imgSrc, initialRect) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "crop-modal-overlay";
    overlay.innerHTML =
      '<div class="crop-modal">' +
      '<div class="crop-modal-hint">Drag inside the box to move it, drag a corner to resize - then Apply crop.</div>' +
      '<div class="crop-modal-stage">' +
      `<img class="crop-modal-img" src="${imgSrc}" draggable="false">` +
      '<div class="crop-modal-rect">' +
      '<div class="crop-modal-handle" data-handle="nw"></div>' +
      '<div class="crop-modal-handle" data-handle="ne"></div>' +
      '<div class="crop-modal-handle" data-handle="sw"></div>' +
      '<div class="crop-modal-handle" data-handle="se"></div>' +
      "</div>" +
      "</div>" +
      '<div class="crop-modal-actions">' +
      '<button class="secondary crop-cancel">Cancel</button>' +
      '<button class="secondary crop-reset">Reset to original</button>' +
      '<button class="crop-confirm">Apply crop</button>' +
      "</div>" +
      "</div>";
    document.body.appendChild(overlay);

    const img = overlay.querySelector(".crop-modal-img");
    const stage = overlay.querySelector(".crop-modal-stage");
    const rectEl = overlay.querySelector(".crop-modal-rect");

    // Percentages of the *displayed* image, 0-100 - converted to real
    // pixel coordinates against img.naturalWidth/Height only at the very
    // end, when actually drawing to canvas. Starts at the previously
    // saved selection, if there is one, rather than always the full
    // image - clamped defensively in case a saved rect somehow ended up
    // out of range (a corrupted override, say), since nothing else here
    // re-validates it once dragging starts.
    let rect = initialRect
      ? {
          x: clamp(initialRect.x, 0, 100),
          y: clamp(initialRect.y, 0, 100),
          w: clamp(initialRect.w, 1, 100 - clamp(initialRect.x, 0, 100)),
          h: clamp(initialRect.h, 1, 100 - clamp(initialRect.y, 0, 100)),
        }
      : { x: 0, y: 0, w: 100, h: 100 };

    function paintRect() {
      rectEl.style.left = `${rect.x}%`;
      rectEl.style.top = `${rect.y}%`;
      rectEl.style.width = `${rect.w}%`;
      rectEl.style.height = `${rect.h}%`;
    }

    function cleanup(result) {
      document.body.removeChild(overlay);
      window.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onKeydown(e) {
      if (e.key === "Escape") cleanup(null);
    }
    window.addEventListener("keydown", onKeydown);

    overlay.querySelector(".crop-cancel").onclick = () => cleanup(null);
    overlay.querySelector(".crop-reset").onclick = () => cleanup("RESET");
    overlay.querySelector(".crop-confirm").onclick = () => {
      const canvas = document.createElement("canvas");
      const sx = (rect.x / 100) * img.naturalWidth;
      const sy = (rect.y / 100) * img.naturalHeight;
      const sw = (rect.w / 100) * img.naturalWidth;
      const sh = (rect.h / 100) * img.naturalHeight;
      canvas.width = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      cleanup({ dataUrl: canvas.toDataURL("image/png"), rect: { ...rect } });
    };

    // Dragging inside the rect moves it; dragging a corner handle
    // resizes it, anchored at the opposite corner. Both tracked as
    // percentages of the stage's own bounding box, so this works
    // regardless of how large the modal happens to render the image.
    let drag = null;
    rectEl.addEventListener("pointerdown", (e) => {
      const handle = e.target.dataset.handle;
      const stageRect = stage.getBoundingClientRect();
      drag = { handle: handle || "move", startX: e.clientX, startY: e.clientY, stageRect, orig: { ...rect } };
      e.preventDefault();
      e.stopPropagation();
    });
    window.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const { stageRect, orig } = drag;
      const dxPct = ((e.clientX - drag.startX) / stageRect.width) * 100;
      const dyPct = ((e.clientY - drag.startY) / stageRect.height) * 100;
      if (drag.handle === "move") {
        rect.x = clamp(orig.x + dxPct, 0, 100 - orig.w);
        rect.y = clamp(orig.y + dyPct, 0, 100 - orig.h);
      } else {
        // Anchor the opposite corner, resize the dragged one.
        const anchorX = drag.handle.includes("w") ? orig.x + orig.w : orig.x;
        const anchorY = drag.handle.includes("n") ? orig.y + orig.h : orig.y;
        const newX = drag.handle.includes("w") ? clamp(orig.x + dxPct, 0, anchorX - 2) : anchorX;
        const newY = drag.handle.includes("n") ? clamp(orig.y + dyPct, 0, anchorY - 2) : anchorY;
        const cornerX = drag.handle.includes("e") ? clamp(orig.x + orig.w + dxPct, anchorX + 2, 100) : anchorX;
        const cornerY = drag.handle.includes("s") ? clamp(orig.y + orig.h + dyPct, anchorY + 2, 100) : anchorY;
        rect.x = Math.min(newX, cornerX);
        rect.y = Math.min(newY, cornerY);
        rect.w = Math.abs(cornerX - newX);
        rect.h = Math.abs(cornerY - newY);
      }
      paintRect();
    });
    window.addEventListener("pointerup", () => {
      drag = null;
    });

    paintRect();
  });
}
