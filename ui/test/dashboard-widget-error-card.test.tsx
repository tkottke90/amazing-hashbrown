import { render, screen } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import { WidgetErrorCard } from '@/pages/dashboard/widget-error-card';

describe('WidgetErrorCard', () => {
  it('renders the error message and an Edit raw file trigger [unit]', () => {
    render(
      <WidgetErrorCard
        id="broken"
        raw="---\nbad\n---"
        error="Invalid widget frontmatter: title: Required"
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByText('Unable to load this widget')).toBeInTheDocument();
    expect(screen.getByText(/Invalid widget frontmatter: title: Required/)).toBeInTheDocument();
    expect(screen.getByTestId('widget-edit-raw-button')).toBeInTheDocument();
  });

  it('carries both the generic and error-specific test ids [unit]', () => {
    render(<WidgetErrorCard id="broken" raw="" error="bad" onChanged={jest.fn()} />);
    expect(screen.getByTestId('widget-error-card')).toBeInTheDocument();
    expect(screen.getByTestId('widget-card')).toBeInTheDocument();
  });

  it('opens the raw-mode drawer pre-filled with the raw content [unit]', () => {
    render(<WidgetErrorCard id="broken" raw={'---\nbad\n---'} error="bad" onChanged={jest.fn()} />);
    expect(screen.getByLabelText('Raw file content')).toHaveValue('---\nbad\n---');
  });
});
