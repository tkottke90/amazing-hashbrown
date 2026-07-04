import { render, screen } from '@testing-library/preact';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardTitle } from '@/components/ui/card';

describe('shadcn ui components on preact', () => {
  it('renders Button', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('renders Card with asChild-free composition', () => {
    render(
      <Card>
        <CardTitle>Title</CardTitle>
        <CardContent>Body</CardContent>
      </Card>,
    );
    expect(screen.getByText('Title')).toBeInTheDocument();
  });

  it('renders Button with asChild', () => {
    render(
      <Button asChild>
        <a href="/somewhere">Link button</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Link button' });
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe('A');
  });
});
