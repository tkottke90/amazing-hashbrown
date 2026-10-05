import { useSignal } from '@preact/signals';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

// Mirrors the backend's whole-string-anchored check
// (api/src/config/credential-value.ts's isEnvRef) — kept as a small local
// copy rather than a cross-workspace import, same as this app's other
// hand-mirrored backend shapes (e.g. trackers-api.ts's AuthField).
function isEnvRef(value: string): string | null {
  return /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value)?.[1] ?? null;
}

interface CredentialValueFieldProps {
  id: string;
  label: string;
  value: string | undefined;
  onChange: (next: string) => void;
  /** Password input + dots in literal mode. Default true. */
  masked?: boolean;
  /** Prefilled when the user switches into "From environment variable" mode with no name yet. */
  suggestedEnvName?: string;
  placeholder?: string;
  helperText?: string;
  disabled?: boolean;
  onKeyDown?: (e: KeyboardEvent) => void;
}

// A value that is either a literal secret/string or a reference to a host
// environment variable ("${NAME}"), with a toggle between the two —
// shared by the git-credentials token, the trackers github token, and
// each shell_exec env row's value. See
// docs/superpowers/specs/2026-10-05-git-credentials-design.md §H.
export function CredentialValueField({
  id,
  label,
  value,
  onChange,
  masked = true,
  suggestedEnvName,
  placeholder,
  helperText,
  disabled,
  onKeyDown,
}: CredentialValueFieldProps) {
  const initialEnvName = isEnvRef(value ?? '');
  const mode = useSignal<'literal' | 'env'>(initialEnvName ? 'env' : 'literal');
  const envName = useSignal(initialEnvName ?? suggestedEnvName ?? '');

  function switchToLiteral() {
    mode.value = 'literal';
    onChange('');
  }

  function switchToEnv() {
    mode.value = 'env';
    const name = envName.value || suggestedEnvName || '';
    envName.value = name;
    onChange(name ? `\${${name}}` : '');
  }

  function handleEnvNameInput(next: string) {
    envName.value = next;
    onChange(next ? `\${${next}}` : '');
  }

  return (
    <div class="space-y-1.5">
      <div class="flex items-center justify-between">
        <Label htmlFor={id}>{label}</Label>
        <div class="flex items-center gap-2">
          <span class="text-xs text-muted-foreground">
            {mode.value === 'env' ? 'From environment variable' : 'Literal value'}
          </span>
          <Switch
            size="sm"
            aria-label={`Source ${label} from an environment variable`}
            checked={mode.value === 'env'}
            disabled={disabled}
            onCheckedChange={(checked) => (checked ? switchToEnv() : switchToLiteral())}
          />
        </div>
      </div>

      {mode.value === 'env' ? (
        <>
          <Input
            id={id}
            type="text"
            value={envName.value}
            disabled={disabled}
            placeholder="GH_TOKEN"
            onInput={(e) => handleEnvNameInput((e.target as HTMLInputElement).value)}
            onKeyDown={onKeyDown}
          />
          <p class="text-xs text-muted-foreground">
            Reads this value from the <code>{envName.value || '<NAME>'}</code> environment variable
            set for the API process.
          </p>
        </>
      ) : (
        <Input
          id={id}
          type={masked ? 'password' : 'text'}
          value={value ?? ''}
          disabled={disabled}
          placeholder={placeholder}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
        />
      )}

      {helperText && <p class="text-xs text-muted-foreground">{helperText}</p>}
    </div>
  );
}
