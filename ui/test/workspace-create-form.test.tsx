import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/workspaces-api', () => ({
  fetchWorkspaces: jest.fn().mockResolvedValue([]),
  fetchProjects: jest.fn().mockResolvedValue([]),
  createWorkspace: jest.fn(),
  createProject: jest.fn(),
  patchWorkspace: jest.fn(),
  deleteWorkspace: jest.fn(),
  closeProject: jest.fn(),
}));

import { CreateWorkspaceForm } from '@/pages/workspaces';
import * as api from '@/services/workspaces-api';

const mockCreateWorkspace = api.createWorkspace as jest.MockedFunction<typeof api.createWorkspace>;
const mockCreateProject = api.createProject as jest.MockedFunction<typeof api.createProject>;

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
