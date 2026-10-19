import { fireEvent, render, screen } from '@testing-library/preact';

jest.mock('@/services/dashboard-api', () => ({
  deleteWidget: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  fetchMetricCatalog: jest.fn().mockResolvedValue([]),
  previewMetricValue: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { MarkdownWidget } from '@/pages/dashboard/markdown-widget';
import * as api from '@/services/dashboard-api';
import { showToast } from '@/lib/toast';
import type { MarkdownWidget as MarkdownWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

// @/components/markdown is globally stubbed (see jest.config.js and
// test/__mocks__/markdown.tsx) to render its children verbatim in a div —
// real markdown parsing is covered by test/markdown.test.tsx. These tests
// only confirm this component wires the widget's fields through correctly.

const mockDelete = api.deleteWidget as jest.MockedFunction<typeof api.deleteWidget>;

function widget(overrides: Partial<MarkdownWidgetData> = {}): MarkdownWidgetData {
  return {
    id: 'w1',
    type: 'markdown',
    title: 'My Title',
    subtitle: 'My Subtitle',
    order: 0,
    source: 'manual',
    updatedAt: '2026-01-01T00:00:00.000Z',
    content: '# hi',
    ...overrides,
  };
}

describe('MarkdownWidget', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it("passes the widget's title and subtitle to WidgetCard [unit]", () => {
    render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
    expect(screen.getByText('My Subtitle')).toBeInTheDocument();
  });

  it('passes content through to Markdown [unit]', () => {
    render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget({ content: '# hi' })}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByText('# hi')).toBeInTheDocument();
  });

  it('omits subtitle markup when absent [unit]', () => {
    const { container } = render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget({ subtitle: undefined })}
        onChanged={jest.fn()}
      />,
    );
    expect(container.querySelector('p')).toBeNull();
  });

  it('delete asks for confirmation, then deletes and calls onChanged [unit]', async () => {
    mockDelete.mockResolvedValue(undefined);
    const onChanged = jest.fn();
    render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    expect(global.confirm).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockDelete).toHaveBeenCalledWith('default', 'w1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('delete does nothing when confirmation is declined [unit]', () => {
    global.confirm = jest.fn(() => false);
    const onChanged = jest.fn();
    render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    expect(mockDelete).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('shows a toast when delete fails [unit]', async () => {
    mockDelete.mockRejectedValue(new Error('server error'));
    render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    await Promise.resolve();
    await Promise.resolve();
    expect(showToast).toHaveBeenCalledWith('error', 'server error');
  });

  it('renders an edit button that opens the widget drawer form [unit]', () => {
    render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('widget-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('widget-drawer-form')).toBeInTheDocument();
  });

  it('renders content in the scrollable region and buttons in the pinned action row [unit]', () => {
    render(
      <MarkdownWidget
        dashboardId="default"
        density="compact"
        widget={widget()}
        onChanged={jest.fn()}
      />,
    );
    expect(screen.getByTestId('widget-content')).toContainElement(screen.getByText('# hi'));
    expect(screen.getByTestId('widget-action')).toContainElement(
      screen.getByTestId('widget-delete-button'),
    );
  });
});
