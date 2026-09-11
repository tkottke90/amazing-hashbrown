import { useEffect } from 'preact/hooks';
import { useTitle } from '@/hooks/use-title';
import { loadSkills } from '@/hooks/use-skills-panel';
import { SkillsList } from './skills-list';
import { SkillDrawer } from './skill-drawer';

export function SkillsPanel() {
  useTitle('Settings - Skills');

  useEffect(() => {
    void loadSkills();
  }, []);

  return (
    <div class="flex h-full flex-col">
      <SkillsList />
      <SkillDrawer />
    </div>
  );
}
