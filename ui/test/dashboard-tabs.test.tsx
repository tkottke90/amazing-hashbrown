import { fireEvent, render, screen } from '@testing-library/preact';
import { DashboardTabs } from '@/pages/dashboard/dashboard-tabs';
import type { DashboardListEntry } from '@/services/dashboard-api';

const DASHBOARDS: DashboardListEntry[] = [
  {
    id: 'default',
    name: 'Default',
    description: '',
    density: 'compact',
    createdAt: '2026-01-01T00:00:00.000Z',
    path: '/dashboard/default',
  },
  {
    id: 'second',
    name: 'Second',
    description: '',
    density: 'compact',
    createdAt: '2026-01-02T00:00:00.000Z',
    path: '/dashboard/second',
  },
];

describe('DashboardTabs', () => {
  it('renders one tab per dashboard with its name as label [unit]', () => {
    render(
      <DashboardTabs
        dashboards={DASHBOARDS}
        activeDashboardId="default"
        onSelect={jest.fn()}
        onCreate={jest.fn()}
      />,
    );
    expect(screen.getByTestId('dashboard-tab-default')).toHaveTextContent('Default');
    expect(screen.getByTestId('dashboard-tab-second')).toHaveTextContent('Second');
  });

  it('marks the active tab [unit]', () => {
    render(
      <DashboardTabs
        dashboards={DASHBOARDS}
        activeDashboardId="second"
        onSelect={jest.fn()}
        onCreate={jest.fn()}
      />,
    );
    expect(screen.getByTestId('dashboard-tab-second')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('dashboard-tab-default')).not.toHaveAttribute('aria-current');
  });

  it('clicking a tab calls onSelect with that dashboard id [unit]', () => {
    const onSelect = jest.fn();
    render(
      <DashboardTabs
        dashboards={DASHBOARDS}
        activeDashboardId="default"
        onSelect={onSelect}
        onCreate={jest.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('dashboard-tab-second'));
    expect(onSelect).toHaveBeenCalledWith('second');
  });

  it('clicking the "+" button calls onCreate [unit]', () => {
    const onCreate = jest.fn();
    render(
      <DashboardTabs
        dashboards={DASHBOARDS}
        activeDashboardId="default"
        onSelect={jest.fn()}
        onCreate={onCreate}
      />,
    );
    fireEvent.click(screen.getByTestId('dashboard-tab-create'));
    expect(onCreate).toHaveBeenCalled();
  });
});
