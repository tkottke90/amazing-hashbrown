import { signal } from '@preact/signals';
import { render } from '@testing-library/preact';
import { language } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';

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

  it('renders the fold gutter for files with foldable syntax', () => {
    const dirty = signal(false);
    const content = '{\n  "a": {\n    "b": 1\n  }\n}';

    const { container, unmount } = render(
      <ThemeProvider>
        <CodeEditor path="data.json" initialContent={content} dirty={dirty} onReady={jest.fn()} />
      </ThemeProvider>,
    );

    expect(container.querySelector('.cm-foldGutter')).toBeInTheDocument();
    expect(() => unmount()).not.toThrow();
  });

  it('gives .yaml files real syntax highlighting instead of falling back to plain text', () => {
    const dirty = signal(false);
    let view: EditorView | undefined;

    const { unmount } = render(
      <ThemeProvider>
        <CodeEditor
          path="config.yaml"
          initialContent="key: value\n"
          dirty={dirty}
          onReady={(v) => {
            view = v;
          }}
        />
      </ThemeProvider>,
    );

    expect(view?.state.facet(language)?.name).toBe('yaml');
    expect(() => unmount()).not.toThrow();
  });
});
