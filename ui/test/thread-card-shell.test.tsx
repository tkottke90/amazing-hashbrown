import { render, screen } from '@testing-library/preact';
import { ThreadCardShell } from '@/components/thread-card-shell';

function slot(name: string) {
  return document.querySelector(`[data-slot="${name}"]`);
}

describe('ThreadCardShell', () => {
  it('renders its children inside the shell', () => {
    render(
      <ThreadCardShell>
        <span>hello</span>
      </ThreadCardShell>,
    );
    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  it('exposes the thread-card-shell data-slot with the bordered card classes', () => {
    render(<ThreadCardShell>content</ThreadCardShell>);
    const shell = slot('thread-card-shell');
    expect(shell).toHaveClass('rounded-md');
    expect(shell).toHaveClass('border');
    expect(shell).toHaveClass('bg-card');
  });

  it('merges an additional className onto the shell', () => {
    render(<ThreadCardShell className="custom-class">content</ThreadCardShell>);
    expect(slot('thread-card-shell')).toHaveClass('custom-class');
  });
});
