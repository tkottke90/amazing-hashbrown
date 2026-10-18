import { fireEvent, render, screen } from '@testing-library/preact';

// Imported via relative path (not the `@/components/markdown` alias) to bypass the
// global jest moduleNameMapper stub and exercise the real component.
import { CodeBlock, MarkdownLink } from '../src/components/markdown';
import { codeBlockWrap } from '@/hooks/use-chat-display-settings';

describe('MarkdownLink', () => {
  it('opens absolute http(s) links in a new tab', () => {
    const { getByText } = render(<MarkdownLink href="https://example.com">link</MarkdownLink>);
    const a = getByText('link');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('opens absolute http links in a new tab', () => {
    const { getByText } = render(<MarkdownLink href="http://example.com">link</MarkdownLink>);
    const a = getByText('link');
    expect(a).toHaveAttribute('target', '_blank');
    expect(a).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('leaves relative links untouched', () => {
    const { getByText } = render(
      <MarkdownLink href="/wiki?view=document&domain=x&page=y.md">link</MarkdownLink>,
    );
    const a = getByText('link');
    expect(a).not.toHaveAttribute('target');
    expect(a).not.toHaveAttribute('rel');
  });

  it('leaves mailto: links untouched', () => {
    const { getByText } = render(<MarkdownLink href="mailto:a@b.com">link</MarkdownLink>);
    const a = getByText('link');
    expect(a).not.toHaveAttribute('target');
    expect(a).not.toHaveAttribute('rel');
  });

  it('leaves anchor links untouched', () => {
    const { getByText } = render(<MarkdownLink href="#section">link</MarkdownLink>);
    const a = getByText('link');
    expect(a).not.toHaveAttribute('target');
    expect(a).not.toHaveAttribute('rel');
  });
});

describe('CodeBlock', () => {
  const INDENTED = '  foo\n    bar';

  beforeEach(() => {
    codeBlockWrap.value = false;
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  it('preserves multi-space indentation in the rendered output [unit]', () => {
    const { container } = render(<CodeBlock>{INDENTED}</CodeBlock>);
    expect(container.querySelector('pre')?.textContent).toBe(INDENTED);
  });

  it('scrolls (does not wrap) by default, preserving whitespace exactly [unit]', () => {
    const { container } = render(<CodeBlock>{INDENTED}</CodeBlock>);
    const pre = container.querySelector('pre');
    expect(pre?.className).toContain('whitespace-pre');
    expect(pre?.className).toContain('overflow-x-auto');
    expect(pre?.className).not.toContain('whitespace-pre-wrap');
    expect(pre?.className).not.toContain('whitespace-pre-line');
  });

  it('wraps long lines instead of scrolling when codeBlockWrap is enabled [unit]', () => {
    codeBlockWrap.value = true;
    const { container } = render(<CodeBlock>{INDENTED}</CodeBlock>);
    const pre = container.querySelector('pre');
    expect(pre?.className).toContain('whitespace-pre-wrap');
    expect(pre?.className).toContain('break-words');
    expect(pre?.className).not.toContain('overflow-x-auto');
  });

  it('copies the unmodified, indented text to the clipboard in scroll mode [unit]', async () => {
    render(<CodeBlock>{INDENTED}</CodeBlock>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INDENTED);
  });

  it('copies the unmodified, indented text to the clipboard in wrap mode [unit]', async () => {
    codeBlockWrap.value = true;
    render(<CodeBlock>{INDENTED}</CodeBlock>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(INDENTED);
  });
});
