import { render, screen } from '@testing-library/preact';

import { TextEllipsis } from '@/components/text-ellipsis';

describe('TextEllipsis', () => {
  it('renders its children', () => {
    render(<TextEllipsis>a-very-long-filename-that-should-truncate.png</TextEllipsis>);
    expect(screen.getByText('a-very-long-filename-that-should-truncate.png')).toBeInTheDocument();
  });

  it('applies the classes needed to truncate inside a flex or grid item', () => {
    render(<TextEllipsis>file.png</TextEllipsis>);
    const el = screen.getByText('file.png');
    expect(el).toHaveClass('block');
    expect(el).toHaveClass('min-w-0');
    expect(el).toHaveClass('truncate');
  });

  it('merges a caller-provided className', () => {
    render(<TextEllipsis className="text-xs">file.png</TextEllipsis>);
    expect(screen.getByText('file.png')).toHaveClass('text-xs', 'truncate');
  });
});
