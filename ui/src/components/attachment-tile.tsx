import { forwardRef } from 'preact/compat';
import { useSignal } from '@preact/signals';
import { AlertTriangle } from 'lucide-preact';

import { cn } from '@/lib/utils';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

export interface AttachmentTileProps {
  id: string;
  filename: string;
  mimeType: string;
  /**
   * Local blob: URL for an image attachment, set the instant it was picked
   * (see chat-input.tsx's stageFile) — rendered blurred underneath the real
   * `/api/v1/artifacts/:id` thumbnail until that network image loads, so
   * the optimistic message bubble never waits on a fetch to show something.
   * UI-local only; never comes from the server.
   */
  previewUrl?: string;
  /** True once the server has resolved this attachment as not sent to the
   * model — strictly `included === false`, never mere truthiness, so a
   * not-yet-resolved optimistic attachment (included still undefined)
   * renders with no badge rather than a false positive. */
  excluded?: boolean;
  exclusionReason?: 'vision_unsupported' | 'artifact_missing';
}

// Colour keyed by extension, not MIME type, since the extension is what's
// visible in the box — distinct colours make skimming a history of mixed
// attachment types easier than one uniform "it's a document" treatment.
// Moved here from chat-message.tsx: this is now the canonical renderer for
// every non-previewable attachment type, reused by the message bubble and
// (via AttachmentPreviewModal) the click-to-open dialog's own fallback.
export const EXTENSION_BOX_CLASSES: Record<string, string> = {
  pdf: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400',
  docx: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  md: 'bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300',
  txt: 'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300',
};
export const DEFAULT_EXTENSION_BOX_CLASSES =
  'bg-gray-100 text-gray-700 dark:bg-gray-800/60 dark:text-gray-300';

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

const EXCLUSION_TOOLTIP_TEXT: Record<
  NonNullable<AttachmentTileProps['exclusionReason']>,
  string
> = {
  vision_unsupported: 'Attachments Not Processed',
  artifact_missing: 'Attachments Not Processed',
};

// forwardRef so this can be used directly as a Dialog/Modal `trigger` (see
// AttachmentPreviewModal) — Dialog.tsx clones the trigger element and
// attaches its own click→showModal ref, which only reaches a real DOM node
// when the component forwards it, same pattern as inbox/index.tsx's TaskRow.
export const AttachmentTile = forwardRef<HTMLButtonElement, AttachmentTileProps>(
  function AttachmentTile({ id, filename, mimeType, previewUrl, excluded, exclusionReason }, ref) {
    const remoteLoaded = useSignal(false);
    const remoteFailed = useSignal(false);
    const isImage = mimeType.startsWith('image/');
    const isVideo = mimeType.startsWith('video/');

    function handleRemoteLoad() {
      remoteLoaded.value = true;
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    }

    return (
      // The badge below is its own interactive Tooltip trigger (a <button>
      // via Radix) — nesting it inside the tile's own <button> would be
      // invalid HTML (button-in-button) and break focus/activation for
      // whichever one loses. Keeping them as positioned siblings under a
      // plain wrapping <div> avoids that while still letting the badge sit
      // visually on top of the tile.
      <div data-slot="chat-message-attachment" className="relative size-20 shrink-0">
        <button
          ref={ref}
          type="button"
          title={filename}
          className="size-full overflow-hidden rounded-md border border-border"
        >
          {isImage && !remoteFailed.value ? (
            <>
              {previewUrl && !remoteLoaded.value && (
                <img
                  src={previewUrl}
                  alt=""
                  aria-hidden="true"
                  className="absolute inset-0 size-full scale-105 object-cover blur-sm"
                />
              )}
              <img
                src={`/api/v1/artifacts/${id}`}
                alt={filename}
                onLoad={handleRemoteLoad}
                onError={() => {
                  remoteFailed.value = true;
                }}
                className={cn(
                  'absolute inset-0 size-full object-cover transition-opacity',
                  previewUrl && !remoteLoaded.value ? 'opacity-0' : 'opacity-100',
                )}
              />
            </>
          ) : isVideo && !remoteFailed.value ? (
            <video
              src={`/api/v1/artifacts/${id}`}
              muted
              onError={() => {
                remoteFailed.value = true;
              }}
              className="absolute inset-0 size-full object-cover"
            />
          ) : (
            <div
              className={cn(
                'flex size-full flex-col items-center justify-center text-xs font-semibold',
                EXTENSION_BOX_CLASSES[extensionOf(filename)] ?? DEFAULT_EXTENSION_BOX_CLASSES,
              )}
            >
              {(extensionOf(filename) || '?').toUpperCase()}
            </div>
          )}
        </button>

        {excluded && (
          <Tooltip>
            <TooltipTrigger
              type="button"
              aria-label="Attachment not processed"
              className="absolute right-0.5 top-0.5 inline-flex size-4 items-center justify-center rounded-full bg-background/90 text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle className="size-3" />
            </TooltipTrigger>
            <TooltipContent>
              {exclusionReason
                ? EXCLUSION_TOOLTIP_TEXT[exclusionReason]
                : 'Attachments Not Processed'}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  },
);
