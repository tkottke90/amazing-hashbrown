import { render, screen } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  validateWidgetRaw: jest.fn(),
  fetchMetricCatalog: jest.fn().mockResolvedValue([]),
  previewMetricValue: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));

import { WidgetErrorCard } from '@/pages/dashboard/widget-error-card';
import { ThemeProvider } from '@/hooks/use-theme';
import type { WidgetLoadResult } from '@tkottke90/amazing-hashbrown-widgets/types';

function errorResult(
  overrides: Partial<Extract<WidgetLoadResult, { status: 'error' }>> = {},
): Extract<WidgetLoadResult, { status: 'error' }> {
  return { status: 'error', id: 'broken', raw: '---\nbad\n---', error: 'bad', ...overrides };
}

describe('WidgetErrorCard', () => {
  it('renders the error message and an Edit raw file trigger [unit]', () => {
    render(
      <ThemeProvider>
        <WidgetErrorCard
          result={errorResult({ error: 'Invalid widget frontmatter: title: Required' })}
          onChanged={jest.fn()}
        />
      </ThemeProvider>,
    );
    expect(screen.getByText('Unable to load this widget')).toBeInTheDocument();
    expect(screen.getByText(/Invalid widget frontmatter: title: Required/)).toBeInTheDocument();
    expect(screen.getByTestId('widget-edit-raw-button')).toBeInTheDocument();
  });

  it('carries both the generic and error-specific test ids [unit]', () => {
    render(
      <ThemeProvider>
        <WidgetErrorCard result={errorResult()} onChanged={jest.fn()} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('widget-error-card')).toBeInTheDocument();
    expect(screen.getByTestId('widget-card')).toBeInTheDocument();
  });

  it('opens the edit drawer straight onto the Raw tab, pre-filled with the raw content [unit]', () => {
    render(
      <ThemeProvider>
        <WidgetErrorCard result={errorResult({ raw: '---\nbad\n---' })} onChanged={jest.fn()} />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('widget-drawer-raw-editor')).toBeInTheDocument();
    expect(screen.queryByLabelText('Title')).not.toBeInTheDocument();
  });
});
