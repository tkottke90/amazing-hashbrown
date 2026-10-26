import { render, screen } from '@testing-library/preact';
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
});
