import { fireEvent, render, screen } from '@testing-library/preact';
import { ThreadReportButton } from '@/components/thread-report-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// jsdom has no `onpointerdown` IDL property, so Preact falls back to
// registering pointer listeners under the un-lowercased event name — mirrors
// dropdown-menu-portal.test.tsx's helper, needed to open Radix's
// pointerdown-driven menu in jsdom.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

describe('ThreadReportButton', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
    document.body.innerHTML = '';
  });

  it('renders the icon button by default and opens the report URL in a new tab when clicked [unit]', () => {
    render(<ThreadReportButton threadId="t1" />);

    fireEvent.click(screen.getByTitle('Generate thread report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/threads/t1/report', '_blank');
  });

  it('renders a menu item when variant="menu-item", opening the report URL on select [unit]', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ThreadReportButton threadId="t2" variant="menu-item" />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    firePointerDown(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Generate thread report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/threads/t2/report', '_blank');
  });
});
