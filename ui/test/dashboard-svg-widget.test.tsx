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

import { SvgWidget } from '@/pages/dashboard/svg-widget';
import * as api from '@/services/dashboard-api';
import type { SvgWidget as SvgWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockDelete = api.deleteWidget as jest.MockedFunction<typeof api.deleteWidget>;

const VALID_SVG = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

function widget(overrides: Partial<SvgWidgetData> = {}): SvgWidgetData {
  return {
    id: 'w1',
    type: 'svg',
    title: 'My Drawing',
    subtitle: 'My Subtitle',
    order: 0,
    source: 'manual',
    updatedAt: '2026-01-01T00:00:00.000Z',
    content: VALID_SVG,
    ...overrides,
  };
}

function renderWidget(w: SvgWidgetData = widget(), onChanged = jest.fn()) {
  return render(
    <SvgWidget dashboardId="default" density="compact" widget={w} onChanged={onChanged} />,
  );
}

describe('SvgWidget', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it("passes the widget's title and subtitle to the card [unit]", () => {
    renderWidget();
    expect(screen.getByText('My Drawing')).toBeInTheDocument();
    expect(screen.getByText('My Subtitle')).toBeInTheDocument();
  });

  it('mounts a valid SVG Source inside the SVG Sandbox shadow root, not the light DOM [unit]', () => {
    const { container } = renderWidget();
    const host = container.querySelector('markdown-svg-sandbox');
    expect(host).not.toBeNull();
    expect(host?.getAttribute('data-fit')).toBe('card');
    expect(host?.shadowRoot?.querySelector('circle')).not.toBeNull();
    expect(container.querySelector('circle')).toBeNull();
    expect(screen.queryByTestId('svg-widget-invalid')).not.toBeInTheDocument();
  });

  it('shows an inline invalid state for non-SVG content instead of crashing [unit]', () => {
    renderWidget(widget({ content: '# just markdown' }));
    expect(screen.getByTestId('svg-widget-invalid')).toBeInTheDocument();
    expect(screen.getByText('My Drawing')).toBeInTheDocument();
  });

  it('shows the invalid state for an empty body [unit]', () => {
    renderWidget(widget({ content: '' }));
    expect(screen.getByTestId('svg-widget-invalid')).toBeInTheDocument();
  });

  it('does not render scripts or event handlers from the SVG Source [unit]', () => {
    const { container } = renderWidget(
      widget({
        content: '<svg><script>window.pwned=1</script><rect onclick="alert(1)"/></svg>',
      }),
    );
    const shadow = container.querySelector('markdown-svg-sandbox')?.shadowRoot;
    expect(shadow?.querySelector('script')).toBeNull();
    expect(shadow?.querySelector('rect')).not.toBeNull();
    expect(shadow?.querySelector('rect')?.getAttribute('onclick')).toBeNull();
  });

  it('delete asks for confirmation, then deletes and calls onChanged [unit]', async () => {
    mockDelete.mockResolvedValue(undefined);
    const onChanged = jest.fn();
    renderWidget(widget(), onChanged);

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    expect(global.confirm).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockDelete).toHaveBeenCalledWith('default', 'w1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers an edit button [unit]', () => {
    renderWidget();
    expect(screen.getByTestId('widget-edit-button')).toBeInTheDocument();
  });
});
