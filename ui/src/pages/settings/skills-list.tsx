import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  skillList,
  skillListLoading,
  skillListError,
  selectSkill,
  startCreateSkill,
  toggleSkillEnabled,
} from '@/hooks/use-skills-panel';

// `tools` is the skill's own non-empty frontmatter field (issue #409) — a
// skill can now gate any number of tools, not just the one hardcoded
// GATED_TOOL_BY_SKILL used to track, so the warning lists whatever it
// actually declares instead of looking up a single name.
function handleToggle(name: string, next: boolean, tools?: string) {
  if (!next && tools) {
    const proceed = confirm(
      `Disabling "${name}" will hide the following tool(s) from the assistant: ${tools}. Continue?`,
    );
    if (!proceed) return;
  }
  void toggleSkillEnabled(name, next);
}

function Badge({ label, on }: { label: string; on?: boolean }) {
  return (
    <span
      class={cn(
        'rounded border px-1.5 py-0.5 text-[10px]',
        on
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-border text-muted-foreground opacity-50',
      )}
      title={`${label}: ${on ? 'has files' : 'none'}`}
    >
      {label}
    </span>
  );
}

export function SkillsList() {
  return (
    <div class="flex flex-1 flex-col">
      <div class="flex items-center justify-between gap-2 border-b border-border p-3">
        <span class="text-sm font-medium text-foreground">Skills</span>
        <Button type="button" size="sm" variant="outline" onClick={startCreateSkill}>
          + New skill
        </Button>
      </div>

      <div class="flex-1 overflow-y-auto">
        {skillListLoading.value && <p class="p-3 text-sm text-muted-foreground">Loading…</p>}
        {skillListError.value && <p class="p-3 text-sm text-destructive">{skillListError.value}</p>}
        {!skillListLoading.value && skillList.value?.length === 0 && (
          <p class="p-3 text-sm text-muted-foreground">No skills yet.</p>
        )}
        <ul class="divide-y divide-border">
          {(skillList.value ?? []).map((skill) => {
            const isGated = Boolean(skill.tools);
            return (
              <li
                key={skill.name}
                data-slot="skill-row"
                class="flex flex-wrap items-center gap-3 px-3 py-2.5 sm:flex-nowrap"
              >
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span class="truncate text-sm font-medium text-foreground">{skill.name}</span>
                    {isGated && (
                      <span
                        class="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground"
                        title={`Required by tool-gating — gates: ${skill.tools}`}
                      >
                        gated
                      </span>
                    )}
                  </span>
                  <span class="truncate text-xs text-muted-foreground">{skill.description}</span>
                </div>

                <div class="flex shrink-0 items-center gap-1">
                  <Badge label="Scripts" on={skill.hasScripts} />
                  <Badge label="Refs" on={skill.hasReferences} />
                  <Badge label="Evals" on={skill.hasEvals} />
                </div>

                <div class="flex shrink-0 items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void selectSkill(skill.name)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={skill.enabled ? 'outline' : 'ghost'}
                    onClick={() => handleToggle(skill.name, !skill.enabled, skill.tools)}
                  >
                    {skill.enabled ? 'Enabled' : 'Disabled'}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
