import { render, screen } from '@testing-library/preact';
import { usePortal } from '../src/portal';

function PortalHarness({ selector }: { selector: string }) {
  const portal = usePortal(selector);
  return <>{portal(<div>Portal content</div>)}</>;
}

describe('usePortal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders into the matching container when the selector resolves', () => {
    const target = document.createElement('div');
    target.id = 'portal-root';
    document.body.appendChild(target);

    render(<PortalHarness selector="#portal-root" />);

    expect(target).toHaveTextContent('Portal content');
  });

  it('falls back to document.body and warns when the selector does not resolve', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    render(<PortalHarness selector="#does-not-exist" />);

    expect(screen.getByText('Portal content')).toBeInTheDocument();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('#does-not-exist'));

    warnSpy.mockRestore();
  });

  it('re-resolves the container when the selector changes', () => {
    const first = document.createElement('div');
    first.id = 'first';
    document.body.appendChild(first);

    const second = document.createElement('div');
    second.id = 'second';
    document.body.appendChild(second);

    const { rerender } = render(<PortalHarness selector="#first" />);
    expect(first).toHaveTextContent('Portal content');

    rerender(<PortalHarness selector="#second" />);

    expect(second).toHaveTextContent('Portal content');
    expect(first).not.toHaveTextContent('Portal content');
  });
});
