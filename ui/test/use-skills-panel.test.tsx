jest.mock('@/services/skills-manage-api', () => {
  const actual = jest.requireActual('@/services/skills-manage-api');
  return {
    ...actual,
    fetchAllSkills: jest.fn(),
    fetchSkill: jest.fn(),
    createSkill: jest.fn(),
    updateSkill: jest.fn(),
    deleteSkill: jest.fn(),
    saveSkillFile: jest.fn(),
    deleteSkillFile: jest.fn(),
    fetchSkillEvals: jest.fn(),
    saveSkillEvals: jest.fn(),
  };
});
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import * as api from '@/services/skills-manage-api';
import type { SkillListItem, SkillDetail, EvalSuite } from '@/services/skills-manage-api';
import { showToast } from '@/lib/toast';
import {
  skillList,
  skillListLoading,
  skillListError,
  selectedSkillName,
  selectedSkill,
  selectedSkillLoading,
  creatingSkill,
  drawerOpen,
  loadSkills,
  selectSkill,
  startCreateSkill,
  closeDrawer,
  createSkillAction,
  saveSkillDetails,
  toggleSkillEnabled,
  deleteSkillAction,
  saveSkillFileAction,
  deleteSkillFileAction,
  loadEvalsAction,
  saveEvalsAction,
  resetSkillsPanelState,
} from '@/hooks/use-skills-panel';

const mockFetchAllSkills = api.fetchAllSkills as jest.MockedFunction<typeof api.fetchAllSkills>;
const mockFetchSkill = api.fetchSkill as jest.MockedFunction<typeof api.fetchSkill>;
const mockCreateSkill = api.createSkill as jest.MockedFunction<typeof api.createSkill>;
const mockUpdateSkill = api.updateSkill as jest.MockedFunction<typeof api.updateSkill>;
const mockDeleteSkill = api.deleteSkill as jest.MockedFunction<typeof api.deleteSkill>;
const mockSaveSkillFile = api.saveSkillFile as jest.MockedFunction<typeof api.saveSkillFile>;
const mockDeleteSkillFile = api.deleteSkillFile as jest.MockedFunction<typeof api.deleteSkillFile>;
const mockFetchSkillEvals = api.fetchSkillEvals as jest.MockedFunction<typeof api.fetchSkillEvals>;
const mockSaveSkillEvals = api.saveSkillEvals as jest.MockedFunction<typeof api.saveSkillEvals>;

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

function skillDetail(overrides: Partial<SkillDetail> = {}): SkillDetail {
  return {
    name: 'my-skill',
    slashCommand: '/my-skill',
    enabled: true,
    path: '/skills/my-skill',
    frontmatter: { name: 'my-skill', description: 'Does a thing' },
    body: 'Body text.',
    scripts: {},
    references: {},
    ...overrides,
  };
}

describe('use-skills-panel — loadSkills', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('on success, sets skillList and clears any prior error', async () => {
    mockFetchAllSkills.mockResolvedValue([skill({ name: 'a' })]);
    skillListError.value = 'stale error';

    await loadSkills();

    expect(skillList.value).toEqual([skill({ name: 'a' })]);
    expect(skillListError.value).toBe(null);
    expect(skillListLoading.value).toBe(false);
  });

  it('on failure, sets the error message and leaves the previous list in place', async () => {
    skillList.value = [skill({ name: 'stale' })];
    mockFetchAllSkills.mockRejectedValue(new Error('network down'));

    await loadSkills();

    expect(skillListError.value).toBe('network down');
    expect(skillList.value).toEqual([skill({ name: 'stale' })]);
    expect(skillListLoading.value).toBe(false);
  });

  it('falls back to a generic message when the failure is not an Error', async () => {
    mockFetchAllSkills.mockRejectedValue('nope');

    await loadSkills();

    expect(skillListError.value).toBe('Failed to load skills');
  });
});

describe('use-skills-panel — selectSkill', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('opens the drawer, exits create mode, and loads the skill on success', async () => {
    creatingSkill.value = true;
    mockFetchSkill.mockResolvedValue(skillDetail({ name: 'x' }));

    await selectSkill('x');

    expect(creatingSkill.value).toBe(false);
    expect(selectedSkillName.value).toBe('x');
    expect(drawerOpen.value).toBe(true);
    expect(selectedSkill.value).toEqual(skillDetail({ name: 'x' }));
    expect(selectedSkillLoading.value).toBe(false);
  });

  it('toasts and clears selectedSkill on failure', async () => {
    mockFetchSkill.mockRejectedValue(new Error('not found'));

    await selectSkill('missing');

    expect(showToast).toHaveBeenCalledWith('error', 'not found');
    expect(selectedSkill.value).toBe(null);
    expect(selectedSkillLoading.value).toBe(false);
  });
});

describe('use-skills-panel — startCreateSkill / closeDrawer', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('startCreateSkill clears selection and opens the drawer in create mode', () => {
    selectedSkillName.value = 'x';
    selectedSkill.value = skillDetail({ name: 'x' });

    startCreateSkill();

    expect(selectedSkillName.value).toBe(null);
    expect(selectedSkill.value).toBe(null);
    expect(creatingSkill.value).toBe(true);
    expect(drawerOpen.value).toBe(true);
  });

  it('closeDrawer resets drawer/create/selection state', () => {
    drawerOpen.value = true;
    creatingSkill.value = true;
    selectedSkillName.value = 'x';
    selectedSkill.value = skillDetail({ name: 'x' });

    closeDrawer();

    expect(drawerOpen.value).toBe(false);
    expect(creatingSkill.value).toBe(false);
    expect(selectedSkillName.value).toBe(null);
    expect(selectedSkill.value).toBe(null);
  });
});

describe('use-skills-panel — createSkillAction', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('on success: toasts, exits create mode, reloads the list, and selects the new skill', async () => {
    const created = skillDetail({ name: 'new-skill' });
    mockCreateSkill.mockResolvedValue(created);
    mockFetchAllSkills.mockResolvedValue([skill({ name: 'new-skill' })]);
    creatingSkill.value = true;

    const result = await createSkillAction({ name: 'new-skill', description: 'd', body: 'b' });

    expect(result).toBe(true);
    expect(showToast).toHaveBeenCalledWith('success', 'Skill "new-skill" created');
    expect(creatingSkill.value).toBe(false);
    expect(mockFetchAllSkills).toHaveBeenCalled();
    expect(selectedSkillName.value).toBe('new-skill');
    expect(selectedSkill.value).toEqual(created);
  });

  it('on failure: toasts and resolves false without touching the list', async () => {
    mockCreateSkill.mockRejectedValue(new Error('duplicate name'));

    const result = await createSkillAction({ name: 'dup', description: 'd', body: 'b' });

    expect(result).toBe(false);
    expect(showToast).toHaveBeenCalledWith('error', 'duplicate name');
    expect(mockFetchAllSkills).not.toHaveBeenCalled();
  });
});

describe('use-skills-panel — saveSkillDetails', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('on success: updates selectedSkill, toasts, reloads the list, and resolves true', async () => {
    const updated = skillDetail({
      name: 'x',
      frontmatter: { name: 'x', description: 'new desc' },
    });
    mockUpdateSkill.mockResolvedValue(updated);
    mockFetchAllSkills.mockResolvedValue([skill({ name: 'x' })]);

    const result = await saveSkillDetails('x', { description: 'new desc' });

    expect(result).toBe(true);
    expect(selectedSkill.value).toEqual(updated);
    expect(showToast).toHaveBeenCalledWith('success', 'Skill saved');
    expect(mockFetchAllSkills).toHaveBeenCalled();
  });

  it('on failure: toasts and resolves false', async () => {
    mockUpdateSkill.mockRejectedValue(new Error('bad input'));

    const result = await saveSkillDetails('x', { description: 'bad' });

    expect(result).toBe(false);
    expect(showToast).toHaveBeenCalledWith('error', 'bad input');
  });
});

describe('use-skills-panel — toggleSkillEnabled', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('flips skillList (and selectedSkill, if it is the same skill) immediately, before the API call resolves', () => {
    skillList.value = [skill({ name: 'a', enabled: true })];
    selectedSkill.value = skillDetail({ name: 'a', enabled: true });
    mockUpdateSkill.mockResolvedValue(skillDetail({ name: 'a', enabled: false }));

    void toggleSkillEnabled('a', false);

    expect(skillList.value).toEqual([skill({ name: 'a', enabled: false })]);
    expect(selectedSkill.value?.enabled).toBe(false);
  });

  it('on success, keeps the optimistic state and shows no error toast', async () => {
    skillList.value = [skill({ name: 'a', enabled: true })];
    mockUpdateSkill.mockResolvedValue(skillDetail({ name: 'a', enabled: false }));

    await toggleSkillEnabled('a', false);

    expect(skillList.value).toEqual([skill({ name: 'a', enabled: false })]);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('on failure, rolls back the list and selectedSkill, and toasts', async () => {
    skillList.value = [skill({ name: 'a', enabled: true })];
    selectedSkill.value = skillDetail({ name: 'a', enabled: true });
    mockUpdateSkill.mockRejectedValue(new Error('server rejected'));

    await toggleSkillEnabled('a', false);

    expect(skillList.value).toEqual([skill({ name: 'a', enabled: true })]);
    expect(selectedSkill.value?.enabled).toBe(true);
    expect(showToast).toHaveBeenCalledWith('error', 'server rejected');
  });
});

describe('use-skills-panel — deleteSkillAction', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('on success: toasts, closes the drawer if the deleted skill was selected, and reloads the list', async () => {
    mockDeleteSkill.mockResolvedValue(undefined);
    mockFetchAllSkills.mockResolvedValue([]);
    selectedSkillName.value = 'gone';
    drawerOpen.value = true;

    const result = await deleteSkillAction('gone');

    expect(result).toBe(true);
    expect(showToast).toHaveBeenCalledWith('success', 'Skill "gone" deleted');
    expect(drawerOpen.value).toBe(false);
    expect(mockFetchAllSkills).toHaveBeenCalled();
  });

  it('leaves the drawer open when the deleted skill was not the selected one', async () => {
    mockDeleteSkill.mockResolvedValue(undefined);
    mockFetchAllSkills.mockResolvedValue([]);
    selectedSkillName.value = 'other';
    drawerOpen.value = true;

    await deleteSkillAction('gone');

    expect(drawerOpen.value).toBe(true);
  });

  it('on failure: toasts and resolves false', async () => {
    mockDeleteSkill.mockRejectedValue(new Error('cannot delete gated skill'));

    const result = await deleteSkillAction('create-workspace');

    expect(result).toBe(false);
    expect(showToast).toHaveBeenCalledWith('error', 'cannot delete gated skill');
  });
});

describe('use-skills-panel — saveSkillFileAction / deleteSkillFileAction', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  it('saveSkillFileAction refreshes both the selected skill and the list on success', async () => {
    mockSaveSkillFile.mockResolvedValue(undefined);
    mockFetchSkill.mockResolvedValue(skillDetail({ name: 'x' }));
    mockFetchAllSkills.mockResolvedValue([skill({ name: 'x', hasScripts: true })]);

    const result = await saveSkillFileAction('x', 'scripts', 'a.js', 'console.log(1);');

    expect(result).toBe(true);
    expect(showToast).toHaveBeenCalledWith('success', 'Saved a.js');
    expect(mockFetchSkill).toHaveBeenCalledWith('x');
    expect(mockFetchAllSkills).toHaveBeenCalled();
  });

  it('saveSkillFileAction toasts and resolves false on failure', async () => {
    mockSaveSkillFile.mockRejectedValue(new Error('disk full'));

    const result = await saveSkillFileAction('x', 'scripts', 'a.js', 'content');

    expect(result).toBe(false);
    expect(showToast).toHaveBeenCalledWith('error', 'disk full');
  });

  it('deleteSkillFileAction refreshes both the selected skill and the list on success', async () => {
    mockDeleteSkillFile.mockResolvedValue(undefined);
    mockFetchSkill.mockResolvedValue(skillDetail({ name: 'x' }));
    mockFetchAllSkills.mockResolvedValue([skill({ name: 'x' })]);

    const result = await deleteSkillFileAction('x', 'scripts', 'a.js');

    expect(result).toBe(true);
    expect(showToast).toHaveBeenCalledWith('success', 'Deleted a.js');
    expect(mockFetchSkill).toHaveBeenCalledWith('x');
    expect(mockFetchAllSkills).toHaveBeenCalled();
  });

  it('deleteSkillFileAction toasts and resolves false on failure', async () => {
    mockDeleteSkillFile.mockRejectedValue(new Error('not found'));

    const result = await deleteSkillFileAction('x', 'scripts', 'a.js');

    expect(result).toBe(false);
    expect(showToast).toHaveBeenCalledWith('error', 'not found');
  });
});

describe('use-skills-panel — loadEvalsAction / saveEvalsAction', () => {
  afterEach(() => {
    resetSkillsPanelState();
    jest.clearAllMocks();
  });

  const suite: EvalSuite = {
    skill_name: 'x',
    evals: [{ id: 1, prompt: 'p', expected_output: 'o' }],
  };

  it('loadEvalsAction returns the fetched suite on success', async () => {
    mockFetchSkillEvals.mockResolvedValue(suite);

    const result = await loadEvalsAction('x');

    expect(result).toEqual(suite);
  });

  it('loadEvalsAction toasts and returns null on failure', async () => {
    mockFetchSkillEvals.mockRejectedValue(new Error('no evals'));

    const result = await loadEvalsAction('x');

    expect(result).toBe(null);
    expect(showToast).toHaveBeenCalledWith('error', 'no evals');
  });

  it('saveEvalsAction toasts, reloads the list, and resolves true on success', async () => {
    mockSaveSkillEvals.mockResolvedValue(undefined);
    mockFetchAllSkills.mockResolvedValue([skill({ name: 'x', hasEvals: true })]);

    const result = await saveEvalsAction('x', suite);

    expect(result).toBe(true);
    expect(showToast).toHaveBeenCalledWith('success', 'Evals saved');
    expect(mockFetchAllSkills).toHaveBeenCalled();
  });

  it('saveEvalsAction toasts and resolves false on failure', async () => {
    mockSaveSkillEvals.mockRejectedValue(new Error('invalid suite'));

    const result = await saveEvalsAction('x', suite);

    expect(result).toBe(false);
    expect(showToast).toHaveBeenCalledWith('error', 'invalid suite');
  });
});
