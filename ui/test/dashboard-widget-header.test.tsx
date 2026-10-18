import { render, screen } from '@testing-library/preact';
import { WidgetHeader } from '@/pages/dashboard/widget-header';

describe('WidgetHeader', () => {
  it('renders the title [unit]', () => {
    render(<WidgetHeader title="My Widget" />);
    expect(screen.getByText('My Widget')).toBeInTheDocument();
  });

  it('renders the subtitle when provided [unit]', () => {
    render(<WidgetHeader title="My Widget" subtitle="My Subtitle" />);
    expect(screen.getByText('My Subtitle')).toBeInTheDocument();
  });

  it('omits subtitle markup when absent, rather than rendering an empty element [unit]', () => {
    const { container } = render(<WidgetHeader title="My Widget" />);
    expect(container.querySelector('p')).toBeNull();
  });

  it('shows no drag handle outside Edit Mode [unit]', () => {
    render(<WidgetHeader title="My Widget" />);
    expect(screen.queryByTestId('widget-drag-handle')).not.toBeInTheDocument();
  });

  it('shows the drag handle in Edit Mode [unit]', () => {
    render(<WidgetHeader title="My Widget" editMode />);
    expect(screen.getByTestId('widget-drag-handle')).toBeInTheDocument();
  });

  it('spreads dragHandleProps only onto the drag handle [unit]', () => {
    const onPointerDown = jest.fn();
    const { container } = render(
      <WidgetHeader
        title="My Widget"
        editMode
        dragHandleProps={{ onPointerDown, 'data-drag': 'x' }}
      />,
    );
    const handle = screen.getByTestId('widget-drag-handle');
    expect(handle).toHaveAttribute('data-drag', 'x');
    expect(container.querySelector('h2')).not.toHaveAttribute('data-drag');
  });
});
