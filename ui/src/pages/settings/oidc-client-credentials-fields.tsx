import type { Signal } from '@preact/signals';
import { useSignal } from '@preact/signals';
import { Loader2 } from 'lucide-preact';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { testOidcToken } from '@/services/providers-api';

export interface OidcClientCredentialsFieldsProps {
  mode: 'add' | 'edit';
  // Resolves a masked ('****') clientSecret against the saved provider's
  // stored secret when verifying — undefined for a brand-new, unsaved
  // provider (there's nothing to resolve against yet).
  providerName?: string;
  tokenUrl: Signal<string>;
  clientId: Signal<string>;
  clientSecret: Signal<string>;
  scope: Signal<string>;
}

// Shared by the Azure OpenAI Provider form and the OpenAI-Compatible
// Provider's oidc-mode form — the Client Credentials fields themselves, plus
// a "Get/refresh token" button that verifies them against the live IdP from
// inside the modal, before Save (see GLOSSARY.md "Client Credentials").
export function OidcClientCredentialsFields({
  mode,
  providerName,
  tokenUrl,
  clientId,
  clientSecret,
  scope,
}: OidcClientCredentialsFieldsProps) {
  const testLoading = useSignal(false);
  const testResult = useSignal<string | null>(null);
  const testError = useSignal<string | null>(null);

  async function handleTestToken() {
    testLoading.value = true;
    testResult.value = null;
    testError.value = null;
    try {
      const { expiresInSeconds } = await testOidcToken({
        providerName: mode === 'edit' ? providerName : undefined,
        tokenUrl: tokenUrl.value.trim(),
        clientId: clientId.value.trim(),
        clientSecret: clientSecret.value || undefined,
        scope: scope.value.trim() || undefined,
      });
      const minutes = Math.round(expiresInSeconds / 60);
      testResult.value = `Token acquired — expires in ${minutes}m`;
    } catch (err) {
      testError.value = err instanceof Error ? err.message : 'Failed to verify credentials.';
    } finally {
      testLoading.value = false;
    }
  }

  return (
    <div class="space-y-3 rounded-md border p-3">
      <p class="text-sm font-medium">Client Credentials</p>
      <div class="space-y-1.5">
        <Label htmlFor="provider-tokenUrl">Token URL</Label>
        <Input
          id="provider-tokenUrl"
          value={tokenUrl.value}
          onInput={(e) => (tokenUrl.value = (e.target as HTMLInputElement).value)}
          placeholder="https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token"
          required
        />
      </div>
      <div class="space-y-1.5">
        <Label htmlFor="provider-clientId">Client ID</Label>
        <Input
          id="provider-clientId"
          value={clientId.value}
          onInput={(e) => (clientId.value = (e.target as HTMLInputElement).value)}
          required
        />
      </div>
      <div class="space-y-1.5">
        <Label htmlFor="provider-clientSecret">Client secret</Label>
        <Input
          id="provider-clientSecret"
          type="password"
          value={clientSecret.value}
          onInput={(e) => (clientSecret.value = (e.target as HTMLInputElement).value)}
          placeholder={mode === 'edit' ? 'Leave blank to keep unchanged' : ''}
        />
      </div>
      <div class="space-y-1.5">
        <Label htmlFor="provider-scope">Scope</Label>
        <Input
          id="provider-scope"
          value={scope.value}
          onInput={(e) => (scope.value = (e.target as HTMLInputElement).value)}
          placeholder="https://cognitiveservices.azure.com/.default"
        />
      </div>
      <div class="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void handleTestToken()}
          disabled={testLoading.value || !tokenUrl.value.trim() || !clientId.value.trim()}
        >
          {testLoading.value && <Loader2 class="size-4 animate-spin" />}
          Get/refresh token
        </Button>
        {testResult.value && <p class="text-xs text-muted-foreground">{testResult.value}</p>}
        {testError.value && <p class="text-xs text-destructive">{testError.value}</p>}
      </div>
    </div>
  );
}
