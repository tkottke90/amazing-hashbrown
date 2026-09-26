import { useState } from 'preact/hooks';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { act } from 'preact/test-utils';

import { ChatInput, ChatInputChip } from '@/components/chat-input';
import { MODEL_SUBMENU_CLOSE_GRACE_MS } from '@/components/provider-model-picker';
import { TooltipProvider } from '@/components/ui/tooltip';

function ControlledChatInput(props: Partial<Parameters<typeof ChatInput>[0]> = {}) {
  const [value, setValue] = useState(props.value ?? '');
  return <ChatInput value={value} onValueChange={setValue} onSend={() => {}} {...props} />;
}

// jsdom has no `onpointerdown` IDL property, so Preact falls back to
// registering pointer listeners under the un-lowercased event name (e.g.
// "PointerDown" instead of "pointerdown") — mirror that here so Radix's
// pointerdown-driven open handlers actually receive the event.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

// Radix's DropdownMenuSubTrigger doesn't open on a bare pointerdown like the
// top-level DropdownMenuTrigger above — it opens on click, or on real
// pointer hover (timing-dependent), or an ArrowRight keypress while
// focused. Layer click + keyboard so this doesn't depend on which of
// those internal paths jsdom's synthetic events actually satisfy.
function openSubmenu(element: HTMLElement) {
  element.focus();
  fireEvent.click(element);
  fireEvent.keyDown(element, { key: 'ArrowRight' });
}

// jsdom has no native PointerEvent, so `fireEvent.pointerEnter`/
// `pointerLeave` silently drop the `pointerType` from their init object —
// the event Preact's handler receives always has `pointerType: undefined`.
// Preact falls back to registering onPointerEnter/onPointerLeave under the
// un-lowercased event name (same fallback as onPointerDown above), so
// building a plain Event under that literal name and attaching
// `pointerType` directly is what actually reaches the handler with the
// value this suite needs to exercise `whenMouse` (issue #130).
function firePointerEvent(
  element: Element,
  type: 'PointerEnter' | 'PointerLeave',
  pointerType: 'mouse' | 'touch',
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  fireEvent(element, event);
}

// @testing-library/preact's fireEvent.change/fireEvent.input wrappers never
// reach a <input type="file">'s listener when a Radix component is also
// mounted in the tree (confirmed: this only affects type="file" specifically
// — a type="text" sibling's fireEvent.change works fine under the same
// conditions, and a raw, non-Preact addEventListener('change', ...) on the
// exact same node also never fires through the wrapper). A plain
// `element.dispatchEvent(new Event('change', {bubbles:true}))` — bypassing
// the wrapper entirely — reaches the listener correctly and is exactly what
// a real browser does on file selection, so that's what this drives instead.
function fireFileInputChange(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
}

describe('ChatInput', () => {
  it('renders the textarea with the given placeholder', () => {
    render(<ControlledChatInput placeholder="Ask anything" />);
    expect(screen.getByPlaceholderText('Ask anything')).toBeInTheDocument();
  });

  it('updates value as the user types', () => {
    render(<ControlledChatInput />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.input(textarea, { target: { value: 'hello' } });
    expect(textarea.value).toBe('hello');
  });

  it('renders header chips when provided', () => {
    render(<ControlledChatInput header={<ChatInputChip>file.png</ChatInputChip>} />);
    expect(screen.getByText('file.png')).toBeInTheDocument();
  });

  it('caps a chip at 300px and truncates its text', () => {
    render(<ChatInputChip>a-very-long-filename-that-should-truncate.png</ChatInputChip>);
    const text = screen.getByText('a-very-long-filename-that-should-truncate.png');
    const chip = text.closest('[data-slot="chat-input-chip"]');
    expect(chip).toHaveClass('max-w-[300px]');
    expect(text).toHaveAttribute('data-slot', 'text-ellipsis');
  });

  it('has no remove button when onRemove is not provided', () => {
    render(<ChatInputChip>file.png</ChatInputChip>);
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
  });

  it('shows a remove button and calls onRemove when clicked', () => {
    const onRemove = jest.fn();
    render(<ChatInputChip onRemove={onRemove}>file.png</ChatInputChip>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('disables send until there is text', () => {
    render(<ControlledChatInput />);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('calls onSend when send is clicked with text present', () => {
    const onSend = jest.fn();
    render(<ControlledChatInput value="hi" onSend={onSend} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('shows a stop button and calls onStop while generating', () => {
    const onStop = jest.fn();
    render(<ControlledChatInput isGenerating onStop={onStop} />);
    const stopButton = screen.getByRole('button', { name: 'Stop generating' });
    expect(stopButton).not.toBeDisabled();
    fireEvent.click(stopButton);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('opens the add-content menu and exposes the add file placeholder', () => {
    const onAddFile = jest.fn();
    render(<ControlledChatInput onAddFile={onAddFile} />);
    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    const item = screen.getByText('Add file');
    fireEvent.click(item);
    expect(onAddFile).toHaveBeenCalledTimes(1);
  });

  it('opens the provider submenu and lists the configured providers', () => {
    const onModelSelect = jest.fn();
    render(
      <ControlledChatInput
        onModelSelect={onModelSelect}
        providers={[
          { name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] },
          { name: 'ollama', type: 'ollama', models: [{ id: 'llama3.2' }] },
        ]}
      />,
    );

    // This only proves ChatInput wires providers/onModelSelect into
    // ProviderModelPicker correctly (the "Provider" submenu renders both
    // configured providers). ProviderModelPicker's own test covers the
    // deeper provider->model->onSelect flow — a third level of nested
    // Radix submenu-in-a-submenu isn't reliably openable via jsdom's
    // synthetic events the way a single level of nesting is.
    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    openSubmenu(screen.getByText('Provider'));

    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('ollama')).toBeInTheDocument();
  });
});

// Regression coverage for issue #130: the outer "Provider" sub-menu mirrors
// ProviderModelPicker's own app-controlled open state (see that component's
// own #130 tests) and had the same gap — its onPointerEnter/onPointerLeave
// handlers never guarded against non-mouse pointer types, so a touch tap's
// synthesized pointerleave could arm a premature close here too.
describe('ChatInput — Provider sub-menu touch never schedules a hover-close (issue #130)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('a touch pointerLeave on the outer Provider trigger never schedules a close', () => {
    render(
      <ControlledChatInput
        providers={[{ name: 'openai', type: 'openai', models: [{ id: 'gpt-4o' }] }]}
      />,
    );
    firePointerDown(screen.getByRole('button', { name: 'Add to message' }));
    const providerTrigger = screen.getByText('Provider');

    firePointerEvent(providerTrigger, 'PointerEnter', 'mouse');
    expect(screen.getByText('openai')).toBeInTheDocument();

    firePointerEvent(providerTrigger, 'PointerLeave', 'touch');
    act(() => {
      jest.advanceTimersByTime(MODEL_SUBMENU_CLOSE_GRACE_MS * 5);
    });

    expect(screen.getByText('openai')).toBeInTheDocument();
  });
});

describe('ChatInput — file attachment', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockUploadSuccess(overrides: Partial<Record<string, unknown>> = {}) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'artifact-1',
        mimeType: 'image/png',
        displayFilename: 'photo.png',
        requiresVision: true,
        ...overrides,
      }),
    }) as unknown as typeof fetch;
  }

  it('uploads a selected file and renders a chip, calling onAttachmentChange', async () => {
    mockUploadSuccess();
    const onAttachmentChange = jest.fn();
    render(<ControlledChatInput threadId="t1" onAttachmentChange={onAttachmentChange} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['bytes'], 'photo.png', { type: 'image/png' });
    fireFileInputChange(input, file);

    await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument());
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/artifacts',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(onAttachmentChange).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'artifact-1', displayFilename: 'photo.png' }),
    );
  });

  it('shows an inline error and does not call onAttachmentChange when the upload fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Unsupported file type' }),
    }) as unknown as typeof fetch;
    const onAttachmentChange = jest.fn();
    render(<ControlledChatInput threadId="t1" onAttachmentChange={onAttachmentChange} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'bad.zip', { type: 'application/zip' }));

    await waitFor(() => expect(screen.getByText('Unsupported file type')).toBeInTheDocument());
    expect(onAttachmentChange).not.toHaveBeenCalled();
  });

  it('clicking the chip remove button deletes the artifact and clears the attachment', async () => {
    mockUploadSuccess();
    const onAttachmentChange = jest.fn();
    render(<ControlledChatInput threadId="t1" onAttachmentChange={onAttachmentChange} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'photo.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument());

    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(global.fetch).toHaveBeenCalledWith(
      '/api/v1/artifacts/artifact-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(screen.queryByText('photo.png')).not.toBeInTheDocument();
    expect(onAttachmentChange).toHaveBeenLastCalledWith(null);
  });

  it('dropping a file uploads it the same way as the file picker', async () => {
    mockUploadSuccess({ displayFilename: 'dropped.png' });
    render(<ControlledChatInput threadId="t1" />);

    const dropZone = document.querySelector('[data-slot="chat-input"]') as HTMLElement;
    const file = new File(['bytes'], 'dropped.png', { type: 'image/png' });
    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } });

    await waitFor(() => expect(screen.getByText('dropped.png')).toBeInTheDocument());
  });

  it('does nothing on drop/select when no threadId is given', () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    render(<ControlledChatInput />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'photo.png', { type: 'image/png' }));

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('ChatInput — vision-capability warning badge', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function renderWithStagedImage(
    providers: Parameters<typeof ControlledChatInput>[0]['providers'],
  ) {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'artifact-1',
        mimeType: 'image/png',
        displayFilename: 'photo.png',
        requiresVision: true,
      }),
    }) as unknown as typeof fetch;

    render(
      <TooltipProvider>
        <ControlledChatInput
          threadId="t1"
          activeProvider="ollama"
          activeModel="llava"
          providers={providers}
        />
      </TooltipProvider>,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireFileInputChange(input, new File(['bytes'], 'photo.png', { type: 'image/png' }));
  }

  it('shows the warning badge when the attachment requires vision and the model does not support it', async () => {
    renderWithStagedImage([
      { name: 'ollama', type: 'ollama', models: [{ id: 'llava', imageInput: false }] },
    ]);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /does not support image input/ }),
      ).toBeInTheDocument(),
    );
  });

  it('hides the warning badge when the model supports vision', async () => {
    renderWithStagedImage([
      { name: 'ollama', type: 'ollama', models: [{ id: 'llava', imageInput: true }] },
    ]);

    await waitFor(() => expect(screen.getByText('photo.png')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: /does not support image input/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the warning badge when no model is known for the provider (conservative default)', async () => {
    renderWithStagedImage([{ name: 'ollama', type: 'ollama', models: [] }]);

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /does not support image input/ }),
      ).toBeInTheDocument(),
    );
  });
});

// #tool-name autocomplete (issue #172). Unlike the /-skill menu, this must
// trigger anywhere in the message (not just position 0) and support more
// than one occurrence per message — see chat-input.tsx's findActiveHashToken.
describe('ChatInput — #tool-name autocomplete', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeToolItem(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      toolId: 'web_fetch',
      name: 'Web Fetch',
      description: 'Fetches a URL and returns its content.',
      category: 'built-in',
      alwaysOn: false,
      mcpServer: null,
      lastSeenAt: null,
      lastStatus: null,
      enabled: true,
      defaultInclude: { chat: true, subAgent: true, autonomous: true },
      instructions: '',
      selected: true,
      ...overrides,
    };
  }

  function mockThreadTools(tools: unknown[]) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ customized: false, tools }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('opens the dropdown when # appears mid-message', async () => {
    mockThreadTools([makeToolItem()]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: 'please use #web_fetch' } });

    await waitFor(() => expect(screen.getByText('#web_fetch')).toBeInTheDocument());
  });

  it('opens the dropdown when # is the first character (parity with /)', async () => {
    mockThreadTools([makeToolItem()]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#web_fetch' } });

    await waitFor(() => expect(screen.getByText('#web_fetch')).toBeInTheDocument());
  });

  it('filters the list client-side as more of the name is typed, without a second fetch', async () => {
    const fetchMock = mockThreadTools([
      makeToolItem({ toolId: 'web_fetch' }),
      makeToolItem({ toolId: 'shell_exec', name: 'Shell Exec' }),
    ]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#' } });
    await waitFor(() => expect(screen.getByText('#web_fetch')).toBeInTheDocument());
    expect(screen.getByText('#shell_exec')).toBeInTheDocument();

    fireEvent.input(textarea, { target: { value: '#web' } });
    await waitFor(() => expect(screen.queryByText('#shell_exec')).not.toBeInTheDocument());
    expect(screen.getByText('#web_fetch')).toBeInTheDocument();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('only lists enabled tools', async () => {
    mockThreadTools([
      makeToolItem({ toolId: 'web_fetch', enabled: true }),
      makeToolItem({ toolId: 'shell_exec', name: 'Shell Exec', enabled: false }),
    ]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#' } });

    await waitFor(() => expect(screen.getByText('#web_fetch')).toBeInTheDocument());
    expect(screen.queryByText('#shell_exec')).not.toBeInTheDocument();
  });

  it('selecting an item replaces only the #token span, not the whole message', async () => {
    mockThreadTools([makeToolItem({ toolId: 'web_fetch' })]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, {
      target: { value: 'please use #web to fetch this', selectionStart: 15, selectionEnd: 15 },
    });
    await waitFor(() => expect(screen.getByText('#web_fetch')).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText('#web_fetch'));

    // The leading # must survive the replacement — the backend's
    // extractRequestedToolIds only matches a #-prefixed token; dropping the
    // # here would silently make the directive a no-op server-side.
    expect(textarea.value).toBe('please use #web_fetch  to fetch this');
  });

  it('preserves the # for an MCP-style toolId containing a colon', async () => {
    mockThreadTools([makeToolItem({ toolId: 'mcp-gateway:pushover-send' })]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#mcp' } });
    await waitFor(() => expect(screen.getByText('#mcp-gateway:pushover-send')).toBeInTheDocument());

    fireEvent.mouseDown(screen.getByText('#mcp-gateway:pushover-send'));

    expect(textarea.value).toBe('#mcp-gateway:pushover-send ');
  });

  it('a second # later in the same message retriggers the dropdown after typing past the first', async () => {
    mockThreadTools([makeToolItem({ toolId: 'web_fetch' })]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#web_fetch' } });
    await waitFor(() => expect(screen.getByText('#web_fetch')).toBeInTheDocument());

    // Continuing to type past the token closes the menu naturally — the
    // caret no longer sits immediately after a '#...' run.
    fireEvent.input(textarea, { target: { value: '#web_fetch this and ' } });
    expect(screen.queryByText('#web_fetch')).not.toBeInTheDocument();

    fireEvent.input(textarea, { target: { value: '#web_fetch this and #web_fetch' } });
    await waitFor(() => expect(screen.getByText('#web_fetch')).toBeInTheDocument());
  });

  it('does not open when there is no threadId', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ControlledChatInput />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#web_fetch' } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('#web_fetch')).not.toBeInTheDocument();
  });

  it('does not trigger for a # embedded in a word (no preceding word boundary)', () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: 'issue#172' } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText('#172')).not.toBeInTheDocument();
  });

  it('matches a substring of toolId, not just a prefix', async () => {
    mockThreadTools([
      makeToolItem({
        toolId: 'mcp-gateway:pushover-send',
        name: 'Pushover Send',
        description: 'Sends a push notification via Pushover.',
      }),
    ]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#push' } });

    await waitFor(() => expect(screen.getByText('#mcp-gateway:pushover-send')).toBeInTheDocument());
  });

  it('matches on name when the query is not in toolId', async () => {
    mockThreadTools([
      makeToolItem({
        toolId: 'notify_slack',
        name: 'Team Pager',
        description: 'Posts a message to a Slack channel.',
      }),
    ]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#pager' } });

    await waitFor(() => expect(screen.getByText('#notify_slack')).toBeInTheDocument());
  });

  it('matches on description when the query is not in toolId or name', async () => {
    mockThreadTools([
      makeToolItem({
        toolId: 'notify_slack',
        name: 'Team Notifier',
        description: 'Posts a reminder message to a Slack channel.',
      }),
    ]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#reminder' } });

    await waitFor(() => expect(screen.getByText('#notify_slack')).toBeInTheDocument());
  });

  it('ranks a toolId match above a description-only match for the same query', async () => {
    mockThreadTools([
      makeToolItem({
        toolId: 'notify_slack',
        name: 'Team Notifier',
        description: 'Posts a push-style reminder to Slack.',
      }),
      makeToolItem({
        toolId: 'push_notification',
        name: 'Push Notification',
        description: 'Sends a mobile push notification.',
      }),
    ]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#push' } });

    await waitFor(() => expect(screen.getByText('#push_notification')).toBeInTheDocument());
    const items = screen.getAllByText(/^#/);
    expect(items.map((el) => el.textContent)).toEqual(['#push_notification', '#notify_slack']);
  });

  it('finds no match when the query appears in none of toolId/name/description', async () => {
    mockThreadTools([makeToolItem({ toolId: 'web_fetch', name: 'Web Fetch' })]);
    render(<ControlledChatInput threadId="t1" />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    fireEvent.input(textarea, { target: { value: '#zzz' } });

    // Give the debounce/fetch a moment, then confirm nothing rendered.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.queryByText('#web_fetch')).not.toBeInTheDocument();
  });
});

// The workspace chat's slash menu lists the workspace's own repo skills
// (.agents/skills) alongside global ones, badged so users can tell which
// /command they're about to run — see
// docs/superpowers/specs/2026-09-26-repo-agent-skills-design.md.
describe('ChatInput — slash-command menu skill source', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockSkills(skills: unknown[]) {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ skills }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const SKILLS = [
    { name: 'global-skill', slashCommand: '/global-skill', description: 'G', source: 'global' },
    { name: 'repo-skill', slashCommand: '/repo-skill', description: 'R', source: 'repo' },
    {
      name: 'shadow',
      slashCommand: '/shadow',
      description: 'S',
      source: 'repo',
      overrides: true,
    },
  ];

  it('queries the workspace skills endpoint when given a workspaceId', async () => {
    const fetchMock = mockSkills(SKILLS);
    render(<ControlledChatInput workspaceId="ws-1" />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '/re' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/workspaces/ws-1/skills?q=re');
  });

  it('queries the global skills endpoint without a workspaceId', async () => {
    const fetchMock = mockSkills(SKILLS.slice(0, 1));
    render(<ControlledChatInput />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '/gl' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/skills?q=gl');
  });

  it('badges repo skills, marks overrides, and leaves global skills unbadged', async () => {
    mockSkills(SKILLS);
    render(<ControlledChatInput workspaceId="ws-1" />);
    fireEvent.input(screen.getByRole('textbox'), { target: { value: '/' } });

    await waitFor(() => expect(screen.getByText('/repo-skill')).toBeInTheDocument());
    const menu = document.querySelector('[data-slot="chat-input-slash-menu"]')!;
    const badges = Array.from(menu.querySelectorAll('[data-slot="card-badge"]')).map(
      (b) => b.textContent,
    );
    expect(badges).toEqual(['repo', 'repo · overrides global']);
  });
});
