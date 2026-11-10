// Reads an uploaded PDF (CV or portfolio) with MuPDF compiled to WebAssembly: no native binaries,
// so it runs on Hostinger's shared hosting. Gives the page count, each page's text, and each page
// rendered as a JPEG small enough to send to a vision model.

import * as mupdf from 'mupdf';

const MAX_TEXT_PER_PAGE = 20_000;

export class PdfError extends Error {}

/**
 * @param {Buffer} buffer
 * @returns {{ pages: number, text(i): string, render(i, { maxPx, quality }): Buffer, close() }}
 */
export function openPdf(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new PdfError('This file is not a PDF.');
  }
  let doc;
  try {
    doc = mupdf.Document.openDocument(buffer, 'application/pdf');
  } catch (err) {
    throw new PdfError(`Could not open the PDF: ${err.message || err}`);
  }
  if (doc.needsPassword?.()) throw new PdfError('This PDF is password-protected. Upload one without a password.');
  const pages = doc.countPages();
  if (!pages) throw new PdfError('This PDF has no pages.');

  return {
    pages,
    text(i) {
      const page = doc.loadPage(i);
      try {
        return page
          .toStructuredText()
          .asText()
          .replace(/\u0000/g, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, MAX_TEXT_PER_PAGE);
      } finally {
        page.destroy?.();
      }
    },
    // The page as a JPEG whose longer side is `maxPx` pixels.
    render(i, { maxPx = 1024, quality = 80 } = {}) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        const scale = maxPx / Math.max(1, Math.max(x1 - x0, y1 - y0));
        const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
        try {
          return Buffer.from(pixmap.asJPEG(quality, false));
        } finally {
          pixmap.destroy?.();
        }
      } finally {
        page.destroy?.();
      }
    },
    close() {
      doc.destroy?.();
    },
  };
}

// All the text of a PDF, pages separated, for a CV.
export function pdfText(buffer, { maxPages = 10 } = {}) {
  const pdf = openPdf(buffer);
  try {
    const parts = [];
    for (let i = 0; i < Math.min(pdf.pages, maxPages); i++) parts.push(pdf.text(i));
    return { pages: pdf.pages, text: parts.join('\n\n').trim() };
  } finally {
    pdf.close();
  }
}
