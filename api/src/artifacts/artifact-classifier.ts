import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export interface ClassificationResult {
  // True when the file needs a vision-capable model to be meaningfully
  // consumed — raw images, and PDFs with no extractable text layer
  // (scanned/image-only pages).
  requiresVision: boolean;
  extractedText: string | null;
}

const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Classifies a just-uploaded file once, at upload time, so neither the
 * capability-warning UI nor the send-time vision-gate ever has to
 * re-process the file. Any MIME type reaching this function is assumed to
 * have already passed the upload handler's allow-list — an unrecognized
 * type here is a programmer error (a gap between the allow-list and this
 * function), not a user-facing case, so it throws rather than guessing.
 */
export async function classifyArtifact(
  mimeType: string,
  buffer: Buffer,
): Promise<ClassificationResult> {
  if (mimeType.startsWith('image/')) {
    return { requiresVision: true, extractedText: null };
  }

  if (mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      // result.text concatenates a "-- N of M --" page-separator marker
      // between pages (confirmed against a real parse) — checking/joining
      // the per-page text instead avoids treating every PDF as "has text"
      // purely because of that marker.
      const hasText = result.pages.some((page) => page.text.trim().length > 0);
      if (!hasText) return { requiresVision: true, extractedText: null };
      return {
        requiresVision: false,
        extractedText: result.pages.map((page) => page.text).join('\n\n'),
      };
    } finally {
      await parser.destroy();
    }
  }

  if (mimeType === DOCX_MIME_TYPE) {
    const { value } = await mammoth.extractRawText({ buffer });
    return { requiresVision: false, extractedText: value };
  }

  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    return { requiresVision: false, extractedText: buffer.toString('utf-8') };
  }

  throw new Error(`classifyArtifact: unrecognized MIME type "${mimeType}"`);
}
