import { signal } from '@preact/signals';
import { render } from '@testing-library/preact';

import { CodeEditor } from '@/pages/workspaces/code-editor';
import { ThemeProvider } from '@/hooks/use-theme';

describe('CodeEditor', () => {
  it('mounts a CodeMirror instance and unmounts cleanly', () => {
    const dirty = signal(false);
    const onReady = jest.fn();

    const { container, unmount } = render(
      <ThemeProvider>
        <CodeEditor path="a.ts" initialContent="const a = 1;" dirty={dirty} onReady={onReady} />
      </ThemeProvider>,
    );

    expect(container.querySelector('.cm-content')).toBeInTheDocument();
    expect(onReady).toHaveBeenCalledTimes(1);

    expect(() => unmount()).not.toThrow();
  });

  it('falls back to plain text for an unrecognized file extension without crashing', () => {
    const dirty = signal(false);

    const { container, unmount } = render(
      <ThemeProvider>
        <CodeEditor path="data.xyz" initialContent="whatever" dirty={dirty} onReady={jest.fn()} />
      </ThemeProvider>,
    );

    expect(container.querySelector('.cm-content')).toBeInTheDocument();
    expect(() => unmount()).not.toThrow();
  });
});
