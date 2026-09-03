import { describe, it } from 'mocha';
import { expect } from 'chai';
import { classifyArtifact } from './artifact-classifier.js';

// Hand-built minimal single-page PDF (no external tooling), so tests don't
// depend on a binary fixture file. Byte offsets are computed as the string
// is built, so this always produces a structurally valid PDF regardless of
// the content-stream length passed in.
function buildMinimalPdf(contentStream: string): Buffer {
  const objects: string[] = [];
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
  objects[3] =
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 200 200] /Contents 5 0 R >>';
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  objects[5] = `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`;

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  return Buffer.from(pdf, 'latin1');
}

// A minimal real .docx (a zip with the three required OOXML parts:
// [Content_Types].xml, _rels/.rels, word/document.xml), containing a
// single paragraph "Hello from a docx". Built once with jszip and mammoth
// verified against it directly; baked in here as base64 so the test suite
// doesn't need a zip-building dependency of its own.
const MINIMAL_DOCX_BASE64 =
  'UEsDBAoAAAAAAGijIl3XeYTquAEAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiPgogIDxEZWZhdWx0IEV4dGVuc2lvbj0icmVscyIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLnJlbGF0aW9uc2hpcHMreG1sIi8+CiAgPERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz4KICA8T3ZlcnJpZGUgUGFydE5hbWU9Ii93b3JkL2RvY3VtZW50LnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC53b3JkcHJvY2Vzc2luZ21sLmRvY3VtZW50Lm1haW4reG1sIi8+CjwvVHlwZXM+UEsDBAoAAAAAAGijIl0AAAAAAAAAAAAAAAAGAAAAX3JlbHMvUEsDBAoAAAAAAGijIl0gG4bqLgEAAC4BAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+CjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPgogIDxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz4KPC9SZWxhdGlvbnNoaXBzPlBLAwQKAAAAAABooyJdAAAAAAAAAAAAAAAABQAAAHdvcmQvUEsDBAoAAAAAAGijIl2KXoh55wAAAOcAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+Cjx3OmRvY3VtZW50IHhtbG5zOnc9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy93b3JkcHJvY2Vzc2luZ21sLzIwMDYvbWFpbiI+CiAgPHc6Ym9keT4KICAgIDx3OnA+PHc6cj48dzp0PkhlbGxvIGZyb20gYSBkb2N4PC93OnQ+PC93OnI+PC93OnA+CiAgPC93OmJvZHk+Cjwvdzpkb2N1bWVudD5QSwECFAAKAAAAAABooyJd13mE6rgBAAC4AQAAEwAAAAAAAAAAAAAAAAAAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAAoAAAAAAGijIl0AAAAAAAAAAAAAAAAGAAAAAAAAAAAAEAAAAOkBAABfcmVscy9QSwECFAAKAAAAAABooyJdIBuG6i4BAAAuAQAACwAAAAAAAAAAAAAAAAANAgAAX3JlbHMvLnJlbHNQSwECFAAKAAAAAABooyJdAAAAAAAAAAAAAAAABQAAAAAAAAAAABAAAABkAwAAd29yZC9QSwECFAAKAAAAAABooyJdil6IeecAAADnAAAAEQAAAAAAAAAAAAAAAACHAwAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAUABQAgAQAAnQQAAAAA';

describe('artifacts/artifact-classifier', () => {
  it('classifies images as requiring vision, with no text extraction', async () => {
    const result = await classifyArtifact('image/png', Buffer.from('fake-image-bytes'));
    expect(result).to.deep.equal({ requiresVision: true, extractedText: null });
  });

  it('classifies a text-bearing PDF as not requiring vision, extracting its text', async function () {
    // pdf-parse's first call in the process loads lazily and can take
    // longer than mocha's 2000ms default, independent of this test's own
    // work — bump the timeout rather than mocking the library out.
    this.timeout(10_000);
    const pdf = buildMinimalPdf('BT /F1 24 Tf 10 100 Td (Hello World) Tj ET');
    const result = await classifyArtifact('application/pdf', pdf);
    expect(result.requiresVision).to.equal(false);
    expect(result.extractedText).to.equal('Hello World');
  });

  it('classifies a scanned/no-text-layer PDF as requiring vision, with no extracted text', async function () {
    // Same cold-start cost as above if this happens to run before the
    // other PDF test.
    this.timeout(10_000);
    const pdf = buildMinimalPdf(''); // empty content stream — no text objects at all
    const result = await classifyArtifact('application/pdf', pdf);
    expect(result).to.deep.equal({ requiresVision: true, extractedText: null });
  });

  it('classifies docx as not requiring vision, extracting its text via mammoth', async () => {
    const docx = Buffer.from(MINIMAL_DOCX_BASE64, 'base64');
    const result = await classifyArtifact(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      docx,
    );
    expect(result.requiresVision).to.equal(false);
    expect(result.extractedText).to.contain('Hello from a docx');
  });

  it('classifies text/plain as not requiring vision, reading the raw bytes', async () => {
    const result = await classifyArtifact('text/plain', Buffer.from('plain text content'));
    expect(result).to.deep.equal({ requiresVision: false, extractedText: 'plain text content' });
  });

  it('classifies text/markdown as not requiring vision, reading the raw bytes', async () => {
    const result = await classifyArtifact('text/markdown', Buffer.from('# Heading\n\nBody'));
    expect(result).to.deep.equal({
      requiresVision: false,
      extractedText: '# Heading\n\nBody',
    });
  });

  it('throws for an unrecognized MIME type (programmer error, not a user-facing case)', async () => {
    let threw = false;
    try {
      await classifyArtifact('application/zip', Buffer.from('whatever'));
    } catch {
      threw = true;
    }
    expect(threw).to.equal(true);
  });
});
