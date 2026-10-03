import { Download } from 'lucide-preact';
import { Modal } from '@tkottke90/preact-dialog';

import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';
import {
  AttachmentTile,
  extensionOf,
  EXTENSION_BOX_CLASSES,
  DEFAULT_EXTENSION_BOX_CLASSES,
} from '@/components/attachment-tile';

export interface AttachmentPreviewModalAttachment {
  id: string;
  filename: string;
  mimeType: string;
}

export interface AttachmentPreviewModalProps {
  attachment: AttachmentPreviewModalAttachment;
  previewUrl?: string;
  excluded?: boolean;
  exclusionReason?: 'vision_unsupported' | 'artifact_missing';
}

// Click-to-open preview: the tile itself is the Modal's trigger (per this
// repo's Dialog convention — see components/AGENTS.md), so clicking any
// attachment tile in a message bubble opens this. Content branches by
// mimeType: image/video get a full-size lightbox, everything else gets a
// plain download dialog — there's no existing lightbox pattern anywhere in
// this codebase to match, so this is new UI rather than a reuse.
export function AttachmentPreviewModal({
  attachment,
  previewUrl,
  excluded,
  exclusionReason,
}: AttachmentPreviewModalProps) {
  return (
    <Modal
      title={attachment.filename}
      trigger={
        <AttachmentTile
          id={attachment.id}
          filename={attachment.filename}
          mimeType={attachment.mimeType}
          previewUrl={previewUrl}
          excluded={excluded}
          exclusionReason={exclusionReason}
        />
      }
    >
      <AttachmentPreviewContent attachment={attachment} />
    </Modal>
  );
}

function AttachmentPreviewContent({
  attachment,
}: {
  attachment: AttachmentPreviewModalAttachment;
}) {
  const src = `/api/v1/artifacts/${attachment.id}`;

  if (attachment.mimeType.startsWith('image/')) {
    return (
      <img src={src} alt={attachment.filename} className="max-h-[70vh] w-full object-contain" />
    );
  }

  if (attachment.mimeType.startsWith('video/')) {
    return <video src={src} controls className="max-h-[70vh] w-full" />;
  }

  const ext = extensionOf(attachment.filename);
  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <div
        className={cn(
          'flex size-20 items-center justify-center rounded-md text-sm font-semibold',
          EXTENSION_BOX_CLASSES[ext] ?? DEFAULT_EXTENSION_BOX_CLASSES,
        )}
      >
        {(ext || '?').toUpperCase()}
      </div>
      <p className="max-w-full truncate text-sm text-muted-foreground">{attachment.filename}</p>
      <a
        href={src}
        download={attachment.filename}
        className={cn(buttonVariants({ variant: 'outline' }), 'gap-2')}
      >
        <Download className="size-4" />
        Download
      </a>
    </div>
  );
}
