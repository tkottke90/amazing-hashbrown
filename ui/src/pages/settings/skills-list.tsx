import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  skillList,
  skillListLoading,
  skillListError,
  selectedSkillName,
  creatingSkill,
  selectSkill,
  startCreateSkill,
  toggleSkillEnabled,
} from '@/hooks/use-skills-panel';
import { GATED_SKILL_NAMES, GATED_TOOL_BY_SKILL } from './skill-gated-names';

function handleToggle(name: string, next: boolean) {
  if (!next && GATED_SKILL_NAMES.includes(name)) {
    const tool = GATED_TOOL_BY_SKILL[name];
    const proceed = confirm(
      `Disabling "${name}" will hide the ${tool} tool from the assistant. Continue?`,
    );
    if (!proceed) return;
  }
  void toggleSkillEnabled(name, next);
}

export function SkillsList() {
  return (
    <div class="flex w-64 shrink-0 flex-col border-r border-border">
      <div class="flex items-center justify-between gap-2 border-b border-border p-3">
        <span class="text-sm font-medium text-foreground">Skills</span>
        <Button type="button" size="sm" variant="outline" onClick={startCreateSkill}>
          + New skill
        </Button>
      </div>

      <div class="flex-1 overflow-y-auto">
        {skillListLoading.value && (
          <p class="p-3 text-sm text-muted-foreground">Loading…</p>
        )}
        {skillListError.value && (
          <p class="p-3 text-sm text-destructive">{skillListError.value}</p>
        )}
        {!skillListLoading.value && skillList.value?.length === 0 && (
          <p class="p-3 text-sm text-muted-foreground">No skills yet.</p>
        )}
        <ul class="divide-y divide-border">
          {(skillList.value ?? []).map((skill) => {
            const isActive = !creatingSkill.value && selectedSkillName.value === skill.name;
            const isGated = GATED_SKILL_NAMES.includes(skill.name);
            return (
              <li
                key={skill.name}
                data-slot="skill-row"
                data-active={isActive ? 'true' : 'false'}
                class={cn(
                  'flex items-start gap-2 px-3 py-2 transition-colors',
                  isActive ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent',
                )}
              >
                <button
                  type="button"
                  onClick={() => void selectSkill(skill.name)}
                  class="flex min-w-0 flex-1 flex-col gap-1 text-left"
                >
                  <span class="flex min-w-0 items-center gap-1.5">
                    <span class="truncate text-sm font-medium text-foreground">{skill.name}</span>
                    {isGated && (
                      <span
                        class="shrink-0 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground"
                        title="Required by tool-gating"
                      >
                        gated
                      </span>
                    )}
                  </span>
                  <span class="truncate text-xs text-muted-foreground">{skill.description}</span>
                </button>
                <Switch
                  size="sm"
                  class="mt-0.5 shrink-0"
                  checked={skill.enabled}
                  onCheckedChange={(checked: boolean) => handleToggle(skill.name, checked)}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
