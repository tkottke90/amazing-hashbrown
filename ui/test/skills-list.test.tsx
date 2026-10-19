import { render, screen, fireEvent } from '@testing-library/preact';

jest.mock('@/hooks/use-skills-panel', () => {
  const actual = jest.requireActual('@/hooks/use-skills-panel');
  return {
    ...actual,
    selectSkill: jest.fn(),
    startCreateSkill: jest.fn(),
    toggleSkillEnabled: jest.fn(),
  };
});

import { SkillsList } from '@/pages/settings/skills-list';
import * as hook from '@/hooks/use-skills-panel';
import {
  skillList,
  skillListLoading,
  skillListError,
  resetSkillsPanelState,
} from '@/hooks/use-skills-panel';
import type { SkillListItem } from '@/services/skills-manage-api';

const mockSelectSkill = hook.selectSkill as jest.MockedFunction<typeof hook.selectSkill>;
const mockStartCreateSkill = hook.startCreateSkill as jest.MockedFunction<
  typeof hook.startCreateSkill
>;
const mockToggleSkillEnabled = hook.toggleSkillEnabled as jest.MockedFunction<
  typeof hook.toggleSkillEnabled
>;

function skill(overrides: Partial<SkillListItem> = {}): SkillListItem {
  return {
    name: 'my-skill',
    description: 'Does a thing',
    slashCommand: '/my-skill',
    enabled: true,
    largeDesc: false,
    ...overrides,
  };
}

describe('SkillsList', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('shows a loading message while the list is loading', () => {
    skillListLoading.value = true;
    render(<SkillsList />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows the error message when loading failed', () => {
    skillListError.value = 'network down';
    render(<SkillsList />);
    expect(screen.getByText('network down')).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no skills', () => {
    skillList.value = [];
    render(<SkillsList />);
    expect(screen.getByText('No skills yet.')).toBeInTheDocument();
  });

  it("renders a skill row's name, description, and file-presence badges", () => {
    skillList.value = [
      skill({
        name: 'my-skill',
        description: 'Does a thing',
        hasScripts: true,
        hasReferences: false,
        hasEvals: true,
      }),
    ];
    render(<SkillsList />);

    expect(screen.getByText('my-skill')).toBeInTheDocument();
    expect(screen.getByText('Does a thing')).toBeInTheDocument();
    expect(screen.getByTitle('Scripts: has files')).toBeInTheDocument();
    expect(screen.getByTitle('Refs: none')).toBeInTheDocument();
    expect(screen.getByTitle('Evals: has files')).toBeInTheDocument();
  });

  it('shows the "gated" badge only for skills in GATED_SKILL_NAMES', () => {
    skillList.value = [skill({ name: 'create-workspace' }), skill({ name: 'ungated-skill' })];
    render(<SkillsList />);

    const rows = document.querySelectorAll('[data-slot="skill-row"]');
    expect(rows[0].querySelector('[title="Required by tool-gating"]')).toBeInTheDocument();
    expect(rows[1].querySelector('[title="Required by tool-gating"]')).not.toBeInTheDocument();
  });

  it("calls selectSkill with the row's name when Edit is clicked", () => {
    skillList.value = [skill({ name: 'my-skill' })];
    render(<SkillsList />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(mockSelectSkill).toHaveBeenCalledWith('my-skill');
  });

  it('calls startCreateSkill when "+ New skill" is clicked', () => {
    skillList.value = [];
    render(<SkillsList />);

    fireEvent.click(screen.getByRole('button', { name: '+ New skill' }));

    expect(mockStartCreateSkill).toHaveBeenCalled();
  });

  it('shows the enabled/disabled label and calls toggleSkillEnabled directly for a non-gated skill', () => {
    skillList.value = [skill({ name: 'ungated-skill', enabled: true })];
    render(<SkillsList />);

    fireEvent.click(screen.getByRole('button', { name: 'Enabled' }));

    expect(mockToggleSkillEnabled).toHaveBeenCalledWith('ungated-skill', false);
  });

  it('confirms before disabling a gated skill, and proceeds when confirmed', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    skillList.value = [skill({ name: 'create-workspace', enabled: true })];
    render(<SkillsList />);

    fireEvent.click(screen.getByRole('button', { name: 'Enabled' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockToggleSkillEnabled).toHaveBeenCalledWith('create-workspace', false);
    confirmSpy.mockRestore();
  });

  it('does not disable a gated skill when the confirmation is cancelled', () => {
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(false);
    skillList.value = [skill({ name: 'create-workspace', enabled: true })];
    render(<SkillsList />);

    fireEvent.click(screen.getByRole('button', { name: 'Enabled' }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(mockToggleSkillEnabled).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('never calls confirm when enabling a gated skill', () => {
    const confirmSpy = jest.spyOn(window, 'confirm');
    skillList.value = [skill({ name: 'create-workspace', enabled: false })];
    render(<SkillsList />);

    fireEvent.click(screen.getByRole('button', { name: 'Disabled' }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockToggleSkillEnabled).toHaveBeenCalledWith('create-workspace', true);
    confirmSpy.mockRestore();
  });
});
