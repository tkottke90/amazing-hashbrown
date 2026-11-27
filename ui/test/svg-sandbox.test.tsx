import { render } from '@testing-library/preact';
import { SvgSandbox } from '../src/components/svg-sandbox';

// Renders SvgSandbox directly — an ordinary Preact component, so this
// bypasses the `react-markdown` mock entirely (it never goes through
// `<Markdown>`). This is the only Jest-reachable way to verify the Shadow
// DOM mounting itself; actual CSS-isolation inside a real browser is a
// Playwright concern (see e2e/tests/markdown-inline-svg.spec.ts).
describe('SvgSandbox', () => {
  it('attaches an open shadow root to the host element [unit]', () => {
    const { container } = render(
      <SvgSandbox>
        <svg>
          <circle cx={1} cy={1} r={1} />
        </svg>
      </SvgSandbox>,
    );

    const host = container.querySelector('markdown-svg-sandbox');
    expect(host).not.toBeNull();
    // `mode: 'closed'` would make shadowRoot unreadable from here — reading
    // it successfully at all confirms 'open'.
    expect(host?.shadowRoot).not.toBeNull();
  });

  it('portals children into the shadow root, not the light DOM [unit]', () => {
    const { container } = render(
      <SvgSandbox>
        <svg data-testid="inner-svg">
          <circle cx={1} cy={1} r={1} />
        </svg>
      </SvgSandbox>,
    );

    const host = container.querySelector('markdown-svg-sandbox');
    expect(host?.querySelector('[data-testid="inner-svg"]')).toBeNull();
    expect(host?.shadowRoot?.querySelector('[data-testid="inner-svg"]')).not.toBeNull();
  });

  it('injects its own :host sizing stylesheet into the shadow root [unit]', () => {
    const { container } = render(
      <SvgSandbox>
        <svg>
          <circle cx={1} cy={1} r={1} />
        </svg>
      </SvgSandbox>,
    );

    const host = container.querySelector('markdown-svg-sandbox');
    const style = host?.shadowRoot?.querySelector('style');
    expect(style?.textContent).toContain('max-width: 100%');
  });

  it('uses flow sizing by default, with no card-fit rules [unit]', () => {
    const { container } = render(
      <SvgSandbox>
        <svg />
      </SvgSandbox>,
    );
    const css = container
      .querySelector('markdown-svg-sandbox')
      ?.shadowRoot?.querySelector('style')?.textContent;
    expect(css).toContain('height: auto');
    expect(css).not.toContain('height: 100%');
  });

  it('fills its container in card fit instead of flowing with text [unit]', () => {
    const { container } = render(
      <SvgSandbox fit="card">
        <svg />
      </SvgSandbox>,
    );
    const css = container
      .querySelector('markdown-svg-sandbox')
      ?.shadowRoot?.querySelector('style')?.textContent;
    expect(css).toContain('width: 100%');
    expect(css).toContain('height: 100%');
    expect(css).not.toContain('height: auto');
  });
});
