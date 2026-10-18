import { render, screen } from '@testing-library/preact';
import { WidgetContent } from '@/pages/dashboard/widget-content';

describe('WidgetContent', () => {
  it('renders its children [unit]', () => {
    render(
      <WidgetContent>
        <span>child content</span>
      </WidgetContent>,
    );
    expect(screen.getByText('child content')).toBeInTheDocument();
  });

  it('is the only region that scrolls — carries flex-1/min-h-0/overflow-auto [unit]', () => {
    render(<WidgetContent>content</WidgetContent>);
    expect(screen.getByTestId('widget-content')).toHaveClass('flex-1', 'min-h-0', 'overflow-auto');
  });
});
