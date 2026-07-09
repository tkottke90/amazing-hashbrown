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
    <div className="group relative my-2 overflow-hidden rounded-md bg-muted">
      {/* Blur-up placeholder: tiny 32px JPEG scaled up, fades out once main loads */}
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

      {/* Download original — visible on hover */}
      <a
        href={`/api/v1/artifacts/${id}/original`}
        download
        aria-label="Download original image"
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-2 right-2 rounded-md bg-black/50 p-1.5 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
      >
        <Download className="size-4" />
      </a>
    </div>
  );
}
