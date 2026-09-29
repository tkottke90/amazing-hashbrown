import { fireEvent, render, screen } from '@testing-library/preact';

import { Layout } from '@/components/layout';
import { ThemeProvider } from '@/hooks/use-theme';

describe('Layout', () => {
  it('renders the aside and main content', () => {
    render(
      <ThemeProvider>
        <Layout aside={<div>Sidebar content</div>}>
          <div>Page content</div>
        </Layout>
      </ThemeProvider>,
    );

    expect(screen.getAllByText('Sidebar content').length).toBeGreaterThan(0);
    expect(screen.getByText('Page content')).toBeInTheDocument();
  });

  it('renders navStart/navEnd icons in the bottom app bar', () => {
    render(
      <ThemeProvider>
        <Layout
          aside={<div>Sidebar content</div>}
          navStart={<button>Search</button>}
          navEnd={<button>Profile</button>}
        >
          <div>Page content</div>
        </Layout>
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument();
  });

  it('calls onAddClick when the floating add button is pressed', () => {
    const onAddClick = jest.fn();
    render(
      <ThemeProvider>
        <Layout aside={<div>Sidebar content</div>} onAddClick={onAddClick}>
          <div>Page content</div>
        </Layout>
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAddClick).toHaveBeenCalledTimes(1);
  });

  it('opens the sheet to reveal the aside content when the hamburger menu is clicked', () => {
    render(
      <ThemeProvider>
        <Layout aside={<div>Sidebar content</div>}>
          <div>Page content</div>
        </Layout>
      </ThemeProvider>,
    );

    expect(screen.getAllByText('Sidebar content')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation menu' }));

    expect(screen.getAllByText('Sidebar content')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('omits the whole bottom bar when hideBottomBar is set', () => {
    render(
      <ThemeProvider>
        <Layout aside={<div>Sidebar content</div>} hideBottomBar>
          <div>Page content</div>
        </Layout>
      </ThemeProvider>,
    );

    expect(screen.queryByRole('navigation', { name: 'Bottom navigation' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Open navigation menu' }),
    ).not.toBeInTheDocument();
  });

  it('omits just the floating add button when hideAddButton is set, keeping the rest of the bar', () => {
    render(
      <ThemeProvider>
        <Layout
          aside={<div>Sidebar content</div>}
          navStart={<button>Search</button>}
          navEnd={<button>Profile</button>}
          hideAddButton
        >
          <div>Page content</div>
        </Layout>
      </ThemeProvider>,
    );

    expect(screen.getByRole('navigation', { name: 'Bottom navigation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Profile' })).toBeInTheDocument();
  });
});
