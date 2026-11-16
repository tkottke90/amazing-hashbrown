import { BookOpen } from 'lucide-preact';
import { ThreadCardShell } from './thread-card-shell';
import { CardBadge } from './card-badge';
import type { WikiOrientationThreadMessage } from '../types/thread-message';

interface WikiOrientationMessageProps {
  message: WikiOrientationThreadMessage;
}

// A mechanical (non-LLM) wiki orientation confirmation card — see
// GLOSSARY.md's "Wiki Orientation" section. Deliberately minimal: name +
// short description only, never anything resembling the schema/index/log
// content the wiki_orient tool itself returns — that's the whole point of
// this card existing instead of letting the agent write a summary.
export function WikiOrientationMessage({ message }: WikiOrientationMessageProps) {
  return (
    <ThreadCardShell>
      <div data-testid="wiki-orientation-card" className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <BookOpen className="size-3.5 shrink-0 text-muted-foreground" />
          {message.action === 'set' && message.wikiId && (
            <CardBadge variant="blue">{message.wikiId}</CardBadge>
          )}
        </div>
        {message.action === 'set' ? (
          <span className="text-sm text-foreground">
            Oriented to wiki — <span className="font-medium">{message.wikiId}</span>
            {message.wikiDescription ? ` — ${message.wikiDescription}` : ''}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">No longer oriented to a wiki</span>
        )}
      </div>
    </ThreadCardShell>
  );
}
