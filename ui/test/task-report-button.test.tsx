import { fireEvent, render, screen } from '@testing-library/preact';
import { TaskReportButton } from '@/components/task-report-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

// jsdom has no `onpointerdown` IDL property, so Preact falls back to
// registering pointer listeners under the un-lowercased event name — mirrors
// thread-report-button.test.tsx's helper, needed to open Radix's
// pointerdown-driven menu in jsdom.
function firePointerDown(element: Element) {
  fireEvent(element, new MouseEvent('PointerDown', { bubbles: true, cancelable: true, button: 0 }));
}

describe('TaskReportButton', () => {
  let openSpy: jest.SpyInstance;

  beforeEach(() => {
    openSpy = jest.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
    document.body.innerHTML = '';
  });

  it('renders the icon button by default and opens the report URL in a new tab when clicked [unit]', () => {
    render(<TaskReportButton taskId="t1" />);

    fireEvent.click(screen.getByTitle('Generate task report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/tasks/t1/report', '_blank');
  });

  it('renders a menu item when variant="menu-item", opening the report URL on select [unit]', () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <TaskReportButton taskId="t2" variant="menu-item" />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    firePointerDown(screen.getByText('Open'));
    fireEvent.click(screen.getByText('Task report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/tasks/t2/report', '_blank');
  });

  it('renders an outlined button with a visible label when variant="outline" [unit]', () => {
    render(<TaskReportButton taskId="t3" variant="outline" />);

    fireEvent.click(screen.getByText('Task Report'));

    expect(openSpy).toHaveBeenCalledWith('/api/v1/tasks/t3/report', '_blank');
  });
});
