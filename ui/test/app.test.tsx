import { render, screen } from '@testing-library/preact';
import { App } from '../src/app';
import { ThemeProvider } from '../src/hooks/use-theme';

describe('App', () => {
  it('renders the chat input', () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    expect(screen.getByPlaceholderText('Message...')).toBeInTheDocument();
  });
});
