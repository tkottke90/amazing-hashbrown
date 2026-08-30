import {
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProviderInfo } from '@/hooks/use-providers';

export interface ProviderModelPickerProps {
  providers: ProviderInfo[];
  activeProvider?: string;
  activeModel?: string;
  onSelect: (provider: string, model: string) => void;
  /**
   * When provided, models this returns `true` for are hidden from that
   * provider's list. A provider whose every model is hidden this way is
   * itself omitted (nothing left to drill into). Omit entirely to render
   * every provider/model unfiltered.
   */
  isModelHidden?: (provider: string, modelId: string) => boolean;
}

// Provider -> model drill-down, shared by the chat input's model switcher
// and the cost-rates Add-rate modal. Renders one DropdownMenuSub per
// provider (nested inside whatever DropdownMenuContent/DropdownMenuSub the
// caller already has open) containing a DropdownMenuCheckboxItem per model.
// Does not render its own outer "Provider" trigger/wrapper — callers that
// want one (e.g. chat-input.tsx, nesting this under an "Add to message"
// menu) render it themselves around this component.
export function ProviderModelPicker({
  providers,
  activeProvider,
  activeModel,
  onSelect,
  isModelHidden,
}: ProviderModelPickerProps) {
  return (
    <>
      {providers.map((p) => {
        const models = isModelHidden
          ? p.models.filter((m) => !isModelHidden(p.name, m.id))
          : p.models;

        if (isModelHidden && models.length === 0) return null;

        return (
          <DropdownMenuSub key={p.name}>
            <DropdownMenuSubTrigger
              className={p.name === activeProvider ? 'font-semibold' : undefined}
            >
              {p.name}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {models.map((m) => (
                <DropdownMenuCheckboxItem
                  key={m.id}
                  checked={m.id === activeModel && p.name === activeProvider}
                  onSelect={() => onSelect(p.name, m.id)}
                >
                  {m.id}
                  {m.inputPricePerM !== undefined && m.outputPricePerM !== undefined && (
                    <DropdownMenuLabel className="ml-2 text-xs text-muted-foreground">
                      ${m.inputPricePerM} / 1M in · ${m.outputPricePerM} / 1M out
                    </DropdownMenuLabel>
                  )}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        );
      })}
    </>
  );
}
