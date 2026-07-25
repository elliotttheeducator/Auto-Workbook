import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import { defaultWorkingSpace } from "./model.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

// Matches the crop resolution the old Python backend used (RENDER_ZOOM=3,
// ~216 DPI) - good enough to print sharp at A4 size.
const CROP_SCALE = 3;

// Proposal rects are PDF points with a top-left origin (the same
// convention PyMuPDF/fitz uses, and the one Claude was already producing
// when reading these PDFs by hand). pdf.js renders to a canvas that is
// also top-left-origin, so a rect scales directly by CROP_SCALE with no
// axis flip needed.
export async function buildProjectFromPdf({ id, title, pdfFile, proposals }) {
  const arrayBuffer = await pdfFile.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pages = [];
  const blobsToSave = [];

  for (let pageNo = 0; pageNo < proposals.length; pageNo++) {
    const pageProposals = proposals[pageNo];
    const needsCrop = pageProposals.some((p) => p.rect);
    let pageCanvas = null;
    if (needsCrop) {
      const page = await doc.getPage(pageNo + 1);
      const viewport = page.getViewport({ scale: CROP_SCALE });
      pageCanvas = document.createElement("canvas");
      pageCanvas.width = Math.ceil(viewport.width);
      pageCanvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: pageCanvas.getContext("2d"), viewport }).promise;
    }

    const blocks = [];
    for (const p of pageProposals) {
      if (p.type === "heading") {
        blocks.push({ type: "heading", id: p.id, text: p.text || "" });
        continue;
      }

      const [x0, y0, x1, y1] = p.rect;
      const sx = x0 * CROP_SCALE;
      const sy = y0 * CROP_SCALE;
      const sw = (x1 - x0) * CROP_SCALE;
      const sh = (y1 - y0) * CROP_SCALE;
      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = Math.max(1, Math.round(sw));
      cropCanvas.height = Math.max(1, Math.round(sh));
      cropCanvas
        .getContext("2d")
        .drawImage(pageCanvas, sx, sy, sw, sh, 0, 0, cropCanvas.width, cropCanvas.height);
      const blob = await new Promise((resolve) => cropCanvas.toBlob(resolve, "image/png"));
      blobsToSave.push({ blockId: p.id, blob });

      if (p.type === "image") {
        blocks.push({ type: "image", id: p.id });
      } else {
        blocks.push({
          type: "question",
          id: p.id,
          contextImage: p.contextImageId || null,
          workingSpace: defaultWorkingSpace(p),
        });
      }
    }
    pages.push({ id: `page${pageNo}`, blocks });
  }

  const workbook = { id, title, sourcePdfName: pdfFile.name, pages, groupLayout: {} };
  return { workbook, blobsToSave };
}
