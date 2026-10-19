import { render, screen } from '@testing-library/preact';

jest.mock('@/hooks/use-skills-panel', () => {
  const actual = jest.requireActual('@/hooks/use-skills-panel');
  return { ...actual, loadSkills: jest.fn() };
});

import { SkillsPanel } from '@/pages/settings/skills-panel';
import * as hook from '@/hooks/use-skills-panel';
import { resetSkillsPanelState } from '@/hooks/use-skills-panel';

const mockLoadSkills = hook.loadSkills as jest.MockedFunction<typeof hook.loadSkills>;

describe('SkillsPanel', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('loads the skill list exactly once on mount', () => {
    render(<SkillsPanel />);
    expect(mockLoadSkills).toHaveBeenCalledTimes(1);
  });

  it('mounts the skills list alongside the drawer', () => {
    render(<SkillsPanel />);
    // A gross wiring break (e.g. SkillsList failing to mount) would make this
    // query come up empty; SkillsList's own rendering/interaction behavior is
    // covered in skills-list.test.tsx, not re-asserted here.
    expect(screen.getByRole('button', { name: '+ New skill' })).toBeInTheDocument();
  });
});
