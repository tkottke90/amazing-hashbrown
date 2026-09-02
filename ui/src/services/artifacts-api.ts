// The allow-list here is UX-only (drives the file picker's `accept`
// attribute) — the server enforces the real gate (see
// api/src/routes/v1/artifacts.handlers.ts's isAllowedMimeType), since a
// multipart upload can carry any MIME type regardless of what the picker
// suggested.
export const ACCEPTED_ATTACHMENT_TYPES =
  'image/*,.pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';

export interface UploadedArtifact {
  id: string;
  mimeType: string;
  displayFilename: string;
  requiresVision: boolean;
}

export async function uploadArtifact(file: File, threadId: string): Promise<UploadedArtifact> {
  const body = new FormData();
  body.append('file', file);
  body.append('threadId', threadId);
  const res = await fetch('/api/v1/artifacts', { method: 'POST', body });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `Upload failed: ${res.status}`);
  }
  return res.json() as Promise<UploadedArtifact>;
}

export async function deleteArtifact(id: string): Promise<void> {
  const res = await fetch(`/api/v1/artifacts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `Delete failed: ${res.status}`);
  }
}
