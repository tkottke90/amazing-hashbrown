import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';

jest.mock('@/services/workspaces-api', () => ({
  fetchWorkspaces: jest.fn().mockResolvedValue([]),
  fetchProjects: jest.fn().mockResolvedValue([]),
  createWorkspace: jest.fn(),
  createProject: jest.fn(),
  patchWorkspace: jest.fn(),
  deleteWorkspace: jest.fn(),
  closeProject: jest.fn(),
}));

jest.mock('@/services/wiki-api', () => ({
  fetchDomains: jest.fn(),
}));

import { CreateWorkspaceForm } from '@/pages/workspaces';
import * as api from '@/services/workspaces-api';
import * as wikiApi from '@/services/wiki-api';

const mockCreateWorkspace = api.createWorkspace as jest.MockedFunction<typeof api.createWorkspace>;
const mockCreateProject = api.createProject as jest.MockedFunction<typeof api.createProject>;
const mockFetchDomains = wikiApi.fetchDomains as jest.MockedFunction<typeof wikiApi.fetchDomains>;

// Radix renders a visually-hidden native <select> alongside the real
// trigger (for form participation), whose <option> text duplicates the
// visible one — scope to the "Wiki binding" field's own container and use
// role="combobox" (the hidden fallback is aria-hidden and excluded from
// role queries by default) to land on the real trigger unambiguously.
function getWikiTrigger() {
  const section = screen.getByText('Wiki binding').closest('div')!;
  return within(section).getByRole('combobox');
}

function fillName(value: string) {
  const input = screen.getByPlaceholderText('my-workspace') as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  // This repo's UI components import `react`, aliased to `preact/compat`
  // (see ui/jest.config.js), which remaps onBlur/onFocus to the bubbling
  // focusout/focusin events to emulate React's synthetic event semantics.
  // Neither RTL's fireEvent.blur() (native, non-bubbling `blur`) nor
  // fireEvent.focusOut() (its constructed event doesn't reach listeners in
  // this jsdom setup) trigger that handler — jsdom's native focus()/blur()
  // DOM methods do, since they run jsdom's real "unfocusing steps" and
  // dispatch both blur and (bubbling) focusout, so use those directly.
  input.focus();
  input.blur();
}

// The submit button lives outside the <form> and is associated via the HTML
// `form` attribute; jsdom correctly runs native required-field constraint
// validation on a button-triggered submit, which would block these tests
// from ever reaching handleSubmit before its own JS-level checks run (that
// browser-level blocking is exercised for real in the Playwright E2E suite
// instead). Dispatching `submit` directly on the form bypasses constraint
// validation, so it isolates handleSubmit's own validation/payload logic.
function submitForm() {
  fireEvent.submit(document.getElementById('create-workspace-form')!);
}

describe('CreateWorkspaceForm — Git repository section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchDomains.mockResolvedValue([]);
  });

  it('hides the Remote URL field until Git is enabled', () => {
    render(<CreateWorkspaceForm />);
    expect(screen.queryByLabelText(/Remote URL/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'Git repository' }));
    expect(screen.getByLabelText(/Remote URL/)).toBeInTheDocument();
  });

  it('requires Remote URL when Git is enabled', async () => {
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);

    fillName('my-ws');
    fireEvent.click(screen.getByRole('switch', { name: 'Git repository' }));
    submitForm();

    expect(
      await screen.findByText('Remote URL is required when Git is enabled.'),
    ).toBeInTheDocument();
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
  });

  it('submits git: true and the trimmed remoteUrl when Git is enabled', async () => {
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);

    fillName('my-ws');
    fireEvent.click(screen.getByRole('switch', { name: 'Git repository' }));
    fireEvent.input(screen.getByLabelText(/Remote URL/), {
      target: { value: '  https://github.com/org/repo  ' },
    });
    submitForm();

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ git: true, remoteUrl: 'https://github.com/org/repo' }),
    );
  });

  it('submits git: false and remoteUrl: null when Git is left disabled', async () => {
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);

    fillName('my-ws');
    submitForm();

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ git: false, remoteUrl: null }),
    );
  });

  it('sends remoteUrl: null even if the field has leftover text after disabling Git', async () => {
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);

    fillName('my-ws');
    const toggle = screen.getByRole('switch', { name: 'Git repository' });
    fireEvent.click(toggle);
    fireEvent.input(screen.getByLabelText(/Remote URL/), {
      target: { value: 'https://github.com/org/repo' },
    });
    fireEvent.click(toggle);

    submitForm();

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ git: false, remoteUrl: null }),
    );
  });

  it('submits git/remoteUrl in project mode too', async () => {
    mockCreateProject.mockResolvedValue({
      workspace: { id: 'ws-1' },
      project: { id: 'ws-1' },
    } as unknown as Awaited<ReturnType<typeof api.createProject>>);
    render(<CreateWorkspaceForm />);

    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fillName('my-proj');
    fireEvent.input(screen.getByPlaceholderText('The project is done when...'), {
      target: { value: 'Ships' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Git repository' }));
    fireEvent.input(screen.getByLabelText(/Remote URL/), {
      target: { value: 'git@host:org/repo.git' },
    });
    submitForm();

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalled());
    expect(mockCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({ git: true, remoteUrl: 'git@host:org/repo.git' }),
    );
  });
});

describe('CreateWorkspaceForm — Dependency isolation section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchDomains.mockResolvedValue([]);
  });

  it('renders both checkboxes unchecked by default', () => {
    render(<CreateWorkspaceForm />);
    expect(screen.getByLabelText(/JavaScript/)).not.toBeChecked();
    expect(screen.getByLabelText(/Python/)).not.toBeChecked();
  });

  it('submits javascript: false, python: false when both are left unchecked', async () => {
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);

    fillName('my-ws');
    submitForm();

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ javascript: false, python: false }),
    );
  });

  it('submits javascript: true when the JavaScript checkbox is checked', async () => {
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);

    fillName('my-ws');
    fireEvent.click(screen.getByLabelText(/JavaScript/));
    submitForm();

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ javascript: true, python: false }),
    );
  });

  it('submits javascript: true and python: true when both checkboxes are checked, in project mode too', async () => {
    mockCreateProject.mockResolvedValue({
      workspace: { id: 'ws-1' },
      project: { id: 'ws-1' },
    } as unknown as Awaited<ReturnType<typeof api.createProject>>);
    render(<CreateWorkspaceForm />);

    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fillName('my-proj');
    fireEvent.input(screen.getByPlaceholderText('The project is done when...'), {
      target: { value: 'Ships' },
    });
    fireEvent.click(screen.getByLabelText(/JavaScript/));
    fireEvent.click(screen.getByLabelText(/Python/));
    submitForm();

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalled());
    expect(mockCreateProject).toHaveBeenCalledWith(
      expect.objectContaining({ javascript: true, python: true }),
    );
  });
});

describe('CreateWorkspaceForm — Wiki binding section', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchDomains.mockResolvedValue([]);
  });

  it('shows None by default and lists fetched domains by their domain field', async () => {
    mockFetchDomains.mockResolvedValue([
      { id: 'wiki-1', domain: 'homelab', tags: [] },
      { id: 'wiki-2', domain: 'nas-migration', tags: [] },
    ]);
    render(<CreateWorkspaceForm />);

    expect(getWikiTrigger().textContent).toContain('None');
    await waitFor(() => expect(getWikiTrigger()).not.toBeDisabled());

    fireEvent.click(getWikiTrigger());
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getByText('homelab')).toBeInTheDocument();
    expect(within(listbox).getByText('nas-migration')).toBeInTheDocument();
  });

  it('submits the selected domain id as wikiId in Workspace mode', async () => {
    mockFetchDomains.mockResolvedValue([{ id: 'wiki-1', domain: 'homelab', tags: [] }]);
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);
    await waitFor(() => expect(getWikiTrigger()).not.toBeDisabled());

    fillName('my-ws');
    fireEvent.click(getWikiTrigger());
    const listbox = await screen.findByRole('listbox');
    fireEvent.click(within(listbox).getByText('homelab'));
    submitForm();

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ wikiId: 'wiki-1' }));
  });

  it('sends wikiId: null when None is left selected', async () => {
    mockFetchDomains.mockResolvedValue([{ id: 'wiki-1', domain: 'homelab', tags: [] }]);
    mockCreateWorkspace.mockResolvedValue({ id: 'ws-1' } as unknown as Awaited<
      ReturnType<typeof api.createWorkspace>
    >);
    render(<CreateWorkspaceForm />);
    await waitFor(() => expect(mockFetchDomains).toHaveBeenCalled());

    fillName('my-ws');
    submitForm();

    await waitFor(() => expect(mockCreateWorkspace).toHaveBeenCalled());
    expect(mockCreateWorkspace).toHaveBeenCalledWith(expect.objectContaining({ wikiId: null }));
  });

  it('shows ephemeral-wiki text and no select in Project mode, always sending wikiId: null', async () => {
    mockFetchDomains.mockResolvedValue([{ id: 'wiki-1', domain: 'homelab', tags: [] }]);
    mockCreateProject.mockResolvedValue({
      workspace: { id: 'ws-1' },
      project: { id: 'ws-1' },
    } as unknown as Awaited<ReturnType<typeof api.createProject>>);
    render(<CreateWorkspaceForm />);

    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    await waitFor(() => expect(mockFetchDomains).toHaveBeenCalled());

    expect(screen.queryByText('Wiki binding')).not.toBeInTheDocument();
    expect(screen.getByText(/Creates an ephemeral wiki domain/)).toBeInTheDocument();

    fillName('my-proj');
    fireEvent.input(screen.getByPlaceholderText('The project is done when...'), {
      target: { value: 'Ships' },
    });
    submitForm();

    await waitFor(() => expect(mockCreateProject).toHaveBeenCalled());
    expect(mockCreateProject).toHaveBeenCalledWith(expect.objectContaining({ wikiId: null }));
  });

  it('does not show an error when the domains list resolves empty', async () => {
    mockFetchDomains.mockResolvedValue([]);
    render(<CreateWorkspaceForm />);
    await waitFor(() => expect(mockFetchDomains).toHaveBeenCalled());

    expect(
      screen.queryByText("Couldn't load wiki domains — check the wiki registry config."),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create workspace' })).not.toBeDisabled();
  });

  it('disables the select and submit and blocks submission when fetchDomains rejects', async () => {
    mockFetchDomains.mockRejectedValue(new Error('503'));
    render(<CreateWorkspaceForm />);

    expect(
      await screen.findByText("Couldn't load wiki domains — check the wiki registry config."),
    ).toBeInTheDocument();

    expect(getWikiTrigger()).toBeDisabled();

    const submitButton = screen.getByRole('button', { name: 'Create workspace' });
    expect(submitButton).toBeDisabled();

    fillName('my-ws');
    submitForm();
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });
});
