import { Volume2 } from 'lucide-preact';
import { cn } from '@/lib/utils';
import type { AudioThreadMessage } from '../types/thread-message';

interface AudioMessageProps {
  message: AudioThreadMessage;
  className?: string;
}

export function AudioMessage({ message, className }: AudioMessageProps) {
  const src = `data:${message.mimeType};base64,${message.audioBase64}`;

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-border bg-card px-4 py-3 max-w-[min(80%,75ch)]',
        className,
      )}
    >
      <Volume2 className="size-4 shrink-0 text-muted-foreground" />
      <audio controls src={src} className="h-8 w-full" />
    </div>
  );
}
