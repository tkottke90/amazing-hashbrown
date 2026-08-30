import { fireEvent, render, screen } from '@testing-library/preact';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
