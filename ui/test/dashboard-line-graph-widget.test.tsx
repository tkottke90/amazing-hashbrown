import { fireEvent, render, screen } from '@testing-library/preact';
import type { JSX } from 'preact';

jest.mock('@/services/dashboard-api', () => ({
  deleteWidget: jest.fn(),
  createWidget: jest.fn(),
  updateWidget: jest.fn(),
  updateWidgetRaw: jest.fn(),
  validateWidgetRaw: jest.fn(),
  DEFAULT_DASHBOARD_ID: 'default',
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { LineGraphWidget } from '@/pages/dashboard/line-graph-widget';
import { ThemeProvider } from '@/hooks/use-theme';
import * as api from '@/services/dashboard-api';
import type { LineGraphWidget as LineGraphWidgetData } from '@tkottke90/amazing-hashbrown-widgets/types';

const mockDelete = api.deleteWidget as jest.MockedFunction<typeof api.deleteWidget>;

function widget(overrides: Partial<LineGraphWidgetData> = {}): LineGraphWidgetData {
  return {
    id: 'w1',
    type: 'line-graph',
    title: 'Response time',
    subtitle: 'Average latency',
    order: 0,
    data: 'label,value\n09:00,120\n09:05,135',
    ...overrides,
  };
}

// The widget's own edit-drawer Form tab mounts a CSV CodeEditor immediately
// for this type (unlike Markdown/Big Number), which needs a ThemeProvider.
function renderWidget(ui: JSX.Element) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe('LineGraphWidget', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    global.confirm = jest.fn(() => true);
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it('renders an svg line from the CSV Body [unit]', () => {
    renderWidget(<LineGraphWidget widget={widget()} onChanged={jest.fn()} />);
    const chart = screen.getByTestId('line-graph-widget');
    expect(chart).toBeInTheDocument();
    expect(chart.querySelector('svg path')).not.toBeNull();
  });

  it("uses the widget's Color Override for the line stroke when present [unit]", () => {
    renderWidget(<LineGraphWidget widget={widget({ color: '#ff0000' })} onChanged={jest.fn()} />);
    const path = screen.getByTestId('line-graph-widget').querySelector('svg path');
    expect(path?.getAttribute('stroke')).toBe('#ff0000');
  });

  it('falls back to the default palette color when no override is set [unit]', () => {
    renderWidget(<LineGraphWidget widget={widget()} onChanged={jest.fn()} />);
    const path = screen.getByTestId('line-graph-widget').querySelector('svg path');
    expect(path?.getAttribute('stroke')).toBe('#6366f1');
  });

  it('delete asks for confirmation, then deletes and calls onChanged [unit]', async () => {
    mockDelete.mockResolvedValue(undefined);
    const onChanged = jest.fn();
    renderWidget(<LineGraphWidget widget={widget()} onChanged={onChanged} />);

    fireEvent.click(screen.getByTestId('widget-delete-button'));

    expect(global.confirm).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(mockDelete).toHaveBeenCalledWith('default', 'w1');
    expect(onChanged).toHaveBeenCalled();
  });

  it('renders an edit button that opens the widget drawer form [unit]', () => {
    renderWidget(<LineGraphWidget widget={widget()} onChanged={jest.fn()} />);
    expect(screen.getByTestId('widget-edit-button')).toBeInTheDocument();
    expect(screen.getByTestId('widget-drawer-form')).toBeInTheDocument();
  });
});
