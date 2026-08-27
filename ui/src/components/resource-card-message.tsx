import { useLocation } from 'preact-iso';
import { ExternalLink, Folder } from 'lucide-preact';
import { ThreadCardShell } from './thread-card-shell';
import { CardBadge } from './card-badge';
import type { ResourceCardThreadMessage } from '../types/thread-message';

const RESOURCE_LABELS: Record<ResourceCardThreadMessage['resourceType'], string> = {
  workspace: 'Workspace',
  project: 'Project',
};

interface ResourceCardMessageProps {
  message: ResourceCardThreadMessage;
}

export function ResourceCardMessage({ message }: ResourceCardMessageProps) {
  const { route } = useLocation();

  return (
    <ThreadCardShell>
      <div data-testid="resource-card" className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <CardBadge variant={message.resourceType === 'project' ? 'violet' : 'blue'}>
            {RESOURCE_LABELS[message.resourceType]}
          </CardBadge>
          <span className="text-sm font-medium text-foreground">{message.name}</span>
        </div>

        {message.goal && <p className="text-sm text-muted-foreground">{message.goal}</p>}

        <p className="font-mono text-xs text-muted-foreground">{message.location}</p>

        <button
          type="button"
          data-testid="resource-card-open-link"
          onClick={() => route(`/workspaces/${message.workspaceId}`)}
          className="flex w-fit items-center gap-1 text-sm text-primary hover:underline"
        >
          Open
          <ExternalLink className="size-3.5" />
        </button>
      </div>
    </ThreadCardShell>
  );
}
