import { Layout } from '@/components/layout';
import { AgentBehaviorPanel } from '@/components/settings/agent-behavior-panel';
import { CostRatesPanel } from '@/components/settings/cost-rates-panel';
import { EmbeddingsPanel } from '@/components/settings/embeddings-panel';
import { GeneralPanel } from '@/components/settings/general-panel';
import { ModelProvidersPanel } from '@/components/settings/model-providers-panel';
import { PlaceholderPanel } from '@/components/settings/placeholder-panel';
import { SettingsNav, VALID_SLUGS, type SettingsSlug } from '@/components/settings/settings-nav';
import { StoragePanel } from '@/components/settings/storage-panel';
import { ToolsPanel } from '@/components/settings/tools-panel';
import { useLocation } from 'preact-iso';

function resolveSection(raw: string | undefined): SettingsSlug {
  if (raw && VALID_SLUGS.has(raw)) return raw as SettingsSlug;
  return 'general';
}

function ActivePanel({ section }: { section: SettingsSlug }) {
  switch (section) {
    case 'general':
      return <GeneralPanel />;
    case 'storage':
      return <StoragePanel />;
    case 'model-providers':
      return <ModelProvidersPanel />;
    case 'embeddings':
      return <EmbeddingsPanel />;
    case 'agent-behavior':
      return <AgentBehaviorPanel />;
    case 'tools':
      return <ToolsPanel />;
    case 'cost-rates':
      return <CostRatesPanel />;
    case 'mcp-servers':
      return <PlaceholderPanel title="MCP Servers" />;
    case 'skills':
      return <PlaceholderPanel title="Skills" />;
    default:
      return <GeneralPanel />;
  }
}

// path prop is consumed by preact-iso's Router for route matching
export function SettingsView(_props: { path?: string }) {
  const { query, route } = useLocation();
  const section = resolveSection(query.section as string | undefined);

  function handleNavigate(slug: SettingsSlug) {
    route(`/settings?section=${slug}`);
  }

  return (
    <Layout>
      <div class="flex h-full">
        <SettingsNav activeSlug={section} onNavigate={handleNavigate} />
        <div class="min-h-0 flex-1 overflow-y-auto">
          <ActivePanel section={section} />
        </div>
      </div>
    </Layout>
  );
}
