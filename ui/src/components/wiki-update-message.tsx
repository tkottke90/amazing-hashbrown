import { BookOpen } from 'lucide-preact';
import type { WikiUpdateThreadMessage } from '../types/thread-message.js';

interface WikiUpdateMessageProps {
  message: WikiUpdateThreadMessage;
}

export function WikiUpdateMessage({ message }: WikiUpdateMessageProps) {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
      <BookOpen className="size-3.5 shrink-0" />
      <span>
        Wiki updated: <span className="font-medium text-foreground">{message.pageTitle}</span>{' '}
        <span className="rounded-full bg-blue-100 px-2 py-0.5 font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          {message.wikiName}
        </span>
      </span>
    </div>
  );
}
