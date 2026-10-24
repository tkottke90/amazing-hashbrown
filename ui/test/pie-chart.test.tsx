import { render, screen, within, fireEvent } from '@testing-library/preact';
import { PieChart } from '@/pages/dashboard/pie-chart';

describe('PieChart', () => {
  it('renders one svg path per label [unit]', () => {
    render(<PieChart labels={['A', 'B', 'C', 'D']} values={[30, 25, 20, 25]} />);
    expect(screen.getByTestId('pie-graph-widget').querySelectorAll('svg path')).toHaveLength(4);
  });

  it('falls back to the default palette per label index when no colors prop is given [unit]', () => {
    render(<PieChart labels={['A', 'B']} values={[1, 1]} />);
    const paths = screen.getByTestId('pie-graph-widget').querySelectorAll('svg path');
    expect(paths[0]?.getAttribute('fill')).toBe('#6366f1');
    expect(paths[1]?.getAttribute('fill')).toBe('#f59e0b');
  });

  it('applies the colors prop positionally and cycles when shorter than the label count [unit]', () => {
    render(
      <PieChart labels={['A', 'B', 'C']} values={[1, 1, 1]} colors={['#111111', '#222222']} />,
    );
    const paths = screen.getByTestId('pie-graph-widget').querySelectorAll('svg path');
    expect(paths[0]?.getAttribute('fill')).toBe('#111111');
    expect(paths[1]?.getAttribute('fill')).toBe('#222222');
    expect(paths[2]?.getAttribute('fill')).toBe('#111111');
  });

  it('renders nothing when labels is empty [unit]', () => {
    render(<PieChart labels={[]} values={[]} />);
    expect(screen.getByTestId('pie-graph-widget').querySelectorAll('svg path')).toHaveLength(0);
  });

  it('renders one legend row per label, showing its label and value [unit]', () => {
    render(<PieChart labels={['Query', 'Analysis']} values={[30, 25]} />);
    const rows = screen.getAllByTestId('pie-chart-legend-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Query')).toBeTruthy();
    expect(within(rows[0]!).getByText('30')).toBeTruthy();
    expect(within(rows[1]!).getByText('Analysis')).toBeTruthy();
    expect(within(rows[1]!).getByText('25')).toBeTruthy();
  });

  it('renders an empty legend when labels is empty [unit]', () => {
    render(<PieChart labels={[]} values={[]} />);
    expect(screen.queryAllByTestId('pie-chart-legend-row')).toHaveLength(0);
  });

  it('hovering a slice dims the other slices and highlights its legend row [unit]', () => {
    render(<PieChart labels={['A', 'B', 'C']} values={[1, 1, 1]} />);
    const paths = screen.getByTestId('pie-graph-widget').querySelectorAll('svg path');
    const rows = screen.getAllByTestId('pie-chart-legend-row');

    fireEvent.mouseEnter(paths[1]!);

    expect(paths[0]?.getAttribute('opacity')).toBe('0.35');
    expect(paths[1]?.getAttribute('opacity')).toBe('1');
    expect(paths[2]?.getAttribute('opacity')).toBe('0.35');
    expect(rows[1]?.className).toContain('bg-muted');
    expect(rows[0]?.className).not.toContain('bg-muted');
  });

  it('hovering a legend row produces the same dimming and shows the tooltip (linked hover) [unit]', () => {
    render(<PieChart labels={['A', 'B']} values={[30, 10]} />);
    const paths = screen.getByTestId('pie-graph-widget').querySelectorAll('svg path');
    const rows = screen.getAllByTestId('pie-chart-legend-row');

    fireEvent.mouseEnter(rows[0]!);

    expect(paths[0]?.getAttribute('opacity')).toBe('1');
    expect(paths[1]?.getAttribute('opacity')).toBe('0.35');
    const tooltip = screen.getByTestId('pie-chart-tooltip');
    expect(within(tooltip).getByText('A')).toBeTruthy();
    expect(within(tooltip).getByText('30 (75%)')).toBeTruthy();
  });

  it('shows 0% rather than NaN% when every value is zero [unit]', () => {
    render(<PieChart labels={['A', 'B']} values={[0, 0]} />);
    const rows = screen.getAllByTestId('pie-chart-legend-row');
    fireEvent.mouseEnter(rows[0]!);
    expect(within(screen.getByTestId('pie-chart-tooltip')).getByText('0 (0%)')).toBeTruthy();
  });

  it('closes the tooltip after the hover debounce, unless the tooltip itself is re-entered [unit]', () => {
    jest.useFakeTimers();
    try {
      render(<PieChart labels={['A', 'B']} values={[1, 1]} />);
      const rows = screen.getAllByTestId('pie-chart-legend-row');
      fireEvent.mouseEnter(rows[0]!);
      expect(screen.getByTestId('pie-chart-tooltip')).toBeTruthy();

      fireEvent.mouseLeave(rows[0]!);
      fireEvent.mouseEnter(screen.getByTestId('pie-chart-tooltip'));
      jest.advanceTimersByTime(200);
      expect(screen.getByTestId('pie-chart-tooltip')).toBeTruthy();

      fireEvent.mouseLeave(screen.getByTestId('pie-chart-tooltip'));
      jest.advanceTimersByTime(200);
      expect(screen.queryByTestId('pie-chart-tooltip')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});
