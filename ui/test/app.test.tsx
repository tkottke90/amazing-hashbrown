const mockClose = jest.fn();
const mockConnectLiveEvents = jest.fn(() => ({ close: mockClose }) as unknown as EventSource);

jest.mock('@/hooks/use-live-events', () => ({
  connectLiveEvents: () => mockConnectLiveEvents(),
}));

import { render, screen, cleanup } from '@testing-library/preact';
import { App } from '../src/app';
import { ThemeProvider } from '../src/hooks/use-theme';

describe('App', () => {
  beforeEach(() => {
    mockConnectLiveEvents.mockClear();
    mockClose.mockClear();
  });

  it('renders the chat input', () => {
    render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    expect(screen.getByPlaceholderText('Message...')).toBeInTheDocument();
  });

  it('opens the standing live-events connection exactly once and closes it on unmount', () => {
    const { unmount } = render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
    expect(mockConnectLiveEvents).toHaveBeenCalledTimes(1);
    expect(mockClose).not.toHaveBeenCalled();

    unmount();
    cleanup();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});
