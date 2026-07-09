import { useSignal } from '@preact/signals';
import { Download, EyeOff } from 'lucide-preact';
import { cn } from '@/lib/utils';

interface ArtifactImageProps {
  id: string;
  alt?: string;
  nsfw?: boolean;
}

export function ArtifactImage({ id, alt, nsfw = false }: ArtifactImageProps) {
  const loaded = useSignal(false);
  const revealed = useSignal(!nsfw);

  return (
    <figure className="not-prose group relative my-2 overflow-hidden rounded-md bg-muted">
      {/* Blur-up placeholder: 32px JPEG scaled up via background-image, fades out on load */}
      <div
        style={{ backgroundImage: `url(/api/v1/artifacts/${id}/preview)` }}
        className={cn(
          'pointer-events-none absolute inset-0 scale-110 bg-cover bg-center blur-lg transition-opacity duration-500',
          loaded.value && 'opacity-0',
        )}
        aria-hidden
      />

      {/* Main lazy-loaded image */}
      <img
        src={`/api/v1/artifacts/${id}`}
        alt={alt ?? 'Image'}
        loading="lazy"
        onLoad={() => {
          loaded.value = true;
        }}
        onClick={() => {
          if (nsfw) revealed.value = !revealed.value;
        }}
        className={cn(
          'block w-full transition-[filter] duration-300',
          !revealed.value && 'cursor-pointer blur-xl',
        )}
      />

      {/* NSFW reveal overlay */}
      {nsfw && !revealed.value && (
        <button
          type="button"
          onClick={() => {
            revealed.value = true;
          }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-sm font-medium text-white"
        >
          <EyeOff className="size-6" />
          Click to reveal
        </button>
      )}

      {/* Caption + download bar
          Mobile: always visible
          Desktop (sm+): hidden until group hover */}
      <figcaption className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/55 px-3 py-2 text-sm text-white transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100">
        <span className="min-w-0 truncate">{alt ?? ''}</span>
        <a
          href={`/api/v1/artifacts/${id}/original`}
          download
          aria-label="Download original image"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded p-1 hover:bg-white/20"
        >
          <Download className="size-4" />
        </a>
      </figcaption>
    </figure>
  );
}
