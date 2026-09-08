import { fireEvent, render, screen } from '@testing-library/preact';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// jsdom has no `onpointerdown` IDL property, so Preact falls back to
// registering pointer listeners under the un-lowercased event name (e.g.
// "PointerDown" instead of "pointerdown") — mirrors chat-input.test.tsx's
// helper, needed to actually open Radix's pointerdown-driven menus in jsdom.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

// These tests render past the @tkottke90/preact-dialog mock entirely (that
// mock is a plain <div>, so it never exercises the real portal-target logic)
// — they append a genuine <dialog> element to the document instead, the
// only way to actually prove DropdownMenuContent/SubContent portal into it
// rather than document.body. See the comment above DropdownMenu in
// dropdown-menu.tsx for the full rationale.
describe('DropdownMenu dialog portal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('portals content into an open <dialog> in the document', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);

    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    firePointerDown(screen.getByText('Open'));

    const item = screen.getByText('Item');
    expect(dialog.contains(item)).toBe(true);
  });

  it('falls back to document.body when no dialog is open', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    firePointerDown(screen.getByText('Open'));

    const item = screen.getByText('Item');
    expect(document.body.contains(item)).toBe(true);
    expect(document.querySelector('dialog')).toBeNull();
  });
});

// Regression coverage for issue #130's real root cause: DropdownMenuSubContent
// used to portal unconditionally (even to plain document.body when no dialog
// was open), which broke Radix's own dismissable-layer "is this pointerdown
// outside?" detection for the chat input's 3-level-deep "Provider -> provider
// -> model" drill-down — see docs/superpowers/specs/
// 2026-09-06-model-picker-touch-close-fix-design.md. SubContent now only
// portals when a dialog is actually open (rate-modal.tsx's case); otherwise
// it renders un-portaled, matching Radix's own default.
describe('DropdownMenu sub-content portal', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function renderWithSub() {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Provider</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Model</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    firePointerDown(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Provider'));
  }

  it('portals sub-content into an open <dialog>', () => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.appendChild(dialog);

    renderWithSub();

    const item = screen.getByText('Model');
    expect(dialog.contains(item)).toBe(true);
  });

  it('renders sub-content un-portaled (a real descendant of the root content) when no dialog is open', () => {
    renderWithSub();

    const rootContent = document.querySelector('[data-slot="dropdown-menu-content"]');
    expect(rootContent).not.toBeNull();
    const item = screen.getByText('Model');
    expect(rootContent?.contains(item)).toBe(true);
  });
});
