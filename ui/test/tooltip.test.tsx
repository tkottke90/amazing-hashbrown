import { render, screen } from '@testing-library/preact';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Radix's real hover/focus-driven open transition doesn't fire in this
// jsdom + testing-library/preact setup — confirmed against the raw
// upstream @radix-ui/react-tooltip package directly, not just this
// wrapper, so it's a jsdom/preact-compat interop limitation (almost
// certainly the useControllableState/useSyncExternalStore re-render path),
// not a bug here. The controlled `open` prop mounts/unmounts
// TooltipContent correctly though, so these tests drive that directly
// instead of simulating a real interaction — this still exercises every
// line this file actually adds (the portal-into-dialog redirection); the
// interaction-triggering mechanism itself is Radix's own tested code.
// Real hover/focus behavior needs a manual/real-browser check (see the
// design spec's Verification section).
describe('Tooltip', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders no content at all when closed', () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Helpful text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.queryByText('Helpful text')).toBeNull();
  });

  it('renders content when open', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Helpful text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    expect(screen.getAllByText('Helpful text').length).toBeGreaterThan(0);
  });

  it('portals content into an open <dialog> in the document', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);

    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Helpful text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const matches = screen.getAllByText('Helpful text');
    expect(matches.some((el) => dialog.contains(el))).toBe(true);
  });

  it('falls back to document.body when no dialog is open', () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Helpful text</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    const matches = screen.getAllByText('Helpful text');
    expect(matches.every((el) => document.body.contains(el))).toBe(true);
    expect(document.querySelector('dialog')).toBeNull();
  });
});
