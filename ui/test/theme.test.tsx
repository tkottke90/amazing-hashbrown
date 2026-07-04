import { fireEvent, render, screen } from '@testing-library/preact';

import { ThemeToggle } from '@/components/theme-toggle';
import { ThemeProvider, useTheme } from '@/hooks/use-theme';

function mockSystemTheme(isDark: boolean) {
  (window.matchMedia as jest.Mock).mockImplementation((query: string) => ({
    matches: isDark,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  }));
}

describe('ThemeProvider / useTheme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    mockSystemTheme(false);
  });

  it('defaults to the light system theme', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('defaults to the dark system theme', () => {
    mockSystemTheme(true);
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('respects a previously stored preference over system settings', () => {
    localStorage.setItem('hashbrown-theme', 'dark');
    mockSystemTheme(false);
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles between light and dark and persists the choice', () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    const toggle = screen.getByRole('button');

    fireEvent.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('hashbrown-theme')).toBe('dark');

    fireEvent.click(toggle);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('hashbrown-theme')).toBe('light');
  });

  it('throws when useTheme is used outside a provider', () => {
    function Bad() {
      useTheme();
      return null;
    }
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bad />)).toThrow('useTheme must be used within a ThemeProvider');
    consoleError.mockRestore();
  });
});
