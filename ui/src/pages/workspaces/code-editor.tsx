import { useEffect, useRef } from 'preact/hooks';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  type LanguageSupport,
} from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import type { Signal } from '@preact/signals';

import { useTheme } from '@/hooks/use-theme';

const EXTENSION_LANGUAGE: Record<string, () => LanguageSupport> = {
  js: javascript,
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  mjs: javascript,
  cjs: javascript,
  py: python,
  json: json,
  md: markdown,
  markdown: markdown,
  html: html,
  htm: html,
  css: css,
};

function languageForPath(path: string): LanguageSupport[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const factory = EXTENSION_LANGUAGE[ext];
  return factory ? [factory()] : [];
}

// Builds an EditorView.theme(...) from this app's own CSS custom properties
// (see ui/src/style.css) rather than a canned package like
// @codemirror/theme-one-dark, so the editor matches the rest of the UI in
// both themes.
export function themeFor(resolvedTheme: 'light' | 'dark') {
  const dark = resolvedTheme === 'dark';
  return EditorView.theme(
    {
      '&': {
        color: 'var(--foreground)',
        backgroundColor: 'var(--background)',
        height: '100%',
      },
      '.cm-content': {
        caretColor: 'var(--foreground)',
      },
      '.cm-gutters': {
        backgroundColor: 'var(--background)',
        color: 'var(--muted-foreground)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLine': {
        backgroundColor: 'var(--muted)',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'var(--muted)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
        backgroundColor: 'var(--muted)',
      },
      '.cm-cursor': {
        borderLeftColor: 'var(--foreground)',
      },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, monospace',
      },
    },
    { dark },
  );
}

export interface CodeEditorProps {
  path: string;
  initialContent: string;
  dirty: Signal<boolean>;
  onReady: (view: EditorView) => void;
}

export function CodeEditor({ path, initialContent, dirty, onReady }: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartmentRef = useRef(new Compartment());
  const { resolvedTheme } = useTheme();

  // One EditorView per mounted instance, keyed by `path` from the parent —
  // a new file gets a fresh editor rather than a reused one.
  useEffect(() => {
    if (!containerRef.current) return;

    const themeCompartment = themeCompartmentRef.current;
    const view = new EditorView({
      state: EditorState.create({
        doc: initialContent,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          syntaxHighlighting(defaultHighlightStyle),
          languageForPath(path),
          themeCompartment.of(themeFor(resolvedTheme)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              dirty.value = true;
            }
          }),
        ],
      }),
      parent: containerRef.current,
    });

    viewRef.current = view;
    onReady(view);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Deliberately only [path]: one view per path, other props are read only
    // at mount time. This repo's eslint config has no react-hooks plugin, so
    // there's no exhaustive-deps rule to disable here.
  }, [path]);

  // Reconfigure the theme compartment when resolvedTheme changes, without
  // recreating the view (which would lose cursor/scroll/undo history).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartmentRef.current.reconfigure(themeFor(resolvedTheme)),
    });
  }, [resolvedTheme]);

  return <div ref={containerRef} class="h-full w-full overflow-auto text-sm" />;
}
