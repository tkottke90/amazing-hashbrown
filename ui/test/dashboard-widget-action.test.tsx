import { render, screen } from '@testing-library/preact';
import { WidgetAction } from '@/pages/dashboard/widget-action';

describe('WidgetAction', () => {
  it('renders its children [unit]', () => {
    render(
      <WidgetAction>
        <button type="button">Edit</button>
      </WidgetAction>,
    );
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });

  it('never scrolls with the content — a plain, non-growing row [unit]', () => {
    render(<WidgetAction>action</WidgetAction>);
    expect(screen.getByTestId('widget-action')).toHaveClass('flex', 'justify-end', 'gap-1');
  });
});
