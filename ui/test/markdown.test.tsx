import { render } from '@testing-library/preact';

// Imported via relative path (not the `@/components/markdown` alias) to bypass the
// global jest moduleNameMapper stub and exercise the real component.
import { MarkdownLink } from '../src/components/markdown';

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
