import { render, screen } from '@testing-library/preact';

// A separate file from thread-sidebar.test.tsx because jest.mock('preact-iso', ...)
// is hoisted to the top of the module and applies file-wide — this file only
// needs the one non-default url value, so it doesn't share a file with tests
// that rely on the global mock's default url: '/'.
jest.mock('preact-iso', () => ({
  ...jest.requireActual('preact-iso'),
  useLocation: () => ({ url: '/wiki', path: '/wiki', query: {}, route: jest.fn() }),
}));

import { ThreadSidebar } from '@/components/thread-sidebar';

describe('ThreadSidebar Dashboard link on another page', () => {
  it('does not mark the Dashboard link active when url is not / [unit]', () => {
    render(<ThreadSidebar />);
    expect(screen.getByRole('link', { name: 'Dashboard' })).not.toHaveClass('bg-sidebar-accent');
  });
});
