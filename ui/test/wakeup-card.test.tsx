import { render, screen, fireEvent, waitFor } from '@testing-library/preact';

const mockCancelWakeup = jest.fn();
const mockTriggerWakeup = jest.fn();

jest.mock('@/services/wakeups-api', () => ({
  cancelWakeup: (...args: unknown[]) => mockCancelWakeup(...args),
  triggerWakeup: (...args: unknown[]) => mockTriggerWakeup(...args),
}));

import { WakeupCard, formatUntil } from '@/components/wakeup-card';
import { WakeupFiredMarker } from '@/components/wakeup-fired-marker';
import type { WakeupFiredThreadMessage, WakeupThreadMessage } from '@/types/thread-message';

function pendingCard(overrides: Partial<WakeupThreadMessage> = {}): WakeupThreadMessage {
  return {
    kind: 'wakeup',
    id: 'w1',
    wakeupId: 'w1',
    note: 'Run kubectl rollout status deploy/api',
    fireAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    state: 'pending',
    ...overrides,
  };
}

afterEach(() => jest.clearAllMocks());

describe('formatUntil', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

  it.each([
    [0.2, 'in under a minute'],
    [14, 'in 14m'],
    [65, 'in 1h 5m'],
    [120, 'in 2h'],
  ])('formats %s minutes ahead as "%s" [unit]', (minutes, text) => {
    expect(formatUntil(at(minutes), now)).toBe(text);
  });
});

describe('WakeupCard', () => {
  it('shows the note and when a pending wake-up will fire [unit]', () => {
    render(<WakeupCard message={pendingCard()} threadId="t1" />);

    expect(screen.getByText('Run kubectl rollout status deploy/api')).toBeInTheDocument();
    expect(screen.getByTestId('wakeup-card-status').textContent).toMatch(/^in 15m · /);
    expect(screen.getByTestId('wakeup-card')).toHaveAttribute('data-state', 'pending');
  });

  it('offers Trigger now and Cancel while pending [unit]', () => {
    render(<WakeupCard message={pendingCard()} threadId="t1" />);

    expect(screen.getByRole('button', { name: 'Trigger now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('is read-only without a thread to act on [unit]', () => {
    render(<WakeupCard message={pendingCard()} />);

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
  });

  it('Cancel calls the API and shows the cancelled card it returns [unit]', async () => {
    mockCancelWakeup.mockResolvedValue({
      ...pendingCard(),
      state: 'cancelled',
      settledBy: 'user_cancel',
    });
    render(<WakeupCard message={pendingCard()} threadId="t1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() =>
      expect(screen.getByTestId('wakeup-card-status').textContent).toBe('Cancelled by you'),
    );
    expect(mockCancelWakeup).toHaveBeenCalledWith('t1', 'w1');
    expect(screen.queryByRole('button', { name: 'Trigger now' })).not.toBeInTheDocument();
  });

  it('Trigger now calls the API and shows the card as fired by the user [unit]', async () => {
    mockTriggerWakeup.mockResolvedValue({
      ...pendingCard(),
      state: 'fired',
      settledBy: 'trigger_now',
      settledAt: new Date().toISOString(),
    });
    render(<WakeupCard message={pendingCard()} threadId="t1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Trigger now' }));

    await waitFor(() =>
      expect(screen.getByTestId('wakeup-card-status').textContent).toMatch(
        /^Fired .*\(triggered by you\)$/,
      ),
    );
    expect(mockTriggerWakeup).toHaveBeenCalledWith('t1', 'w1');
  });

  it('shows the error and keeps the buttons when an action fails [unit]', async () => {
    mockCancelWakeup.mockRejectedValue(new Error('Wake-up is no longer pending'));
    render(<WakeupCard message={pendingCard()} threadId="t1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Wake-up is no longer pending');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it("shows the agent's reason when the agent cancelled [unit]", () => {
    render(
      <WakeupCard
        message={pendingCard({
          state: 'cancelled',
          settledBy: 'agent_cancel',
          cancelReason: 'deploy finished early',
        })}
        threadId="t1"
      />,
    );

    expect(screen.getByTestId('wakeup-card-status').textContent).toBe(
      'Cancelled by agent: deploy finished early',
    );
  });

  it('explains a late catch-up fire [unit]', () => {
    render(
      <WakeupCard
        message={pendingCard({
          state: 'fired',
          settledBy: 'catch_up',
          settledAt: new Date().toISOString(),
        })}
      />,
    );

    expect(screen.getByTestId('wakeup-card-status').textContent).toMatch(
      /late — the server was offline/,
    );
  });
});

describe('WakeupFiredMarker', () => {
  const marker = (overrides: Partial<WakeupFiredThreadMessage> = {}): WakeupFiredThreadMessage => ({
    kind: 'wakeup_fired',
    id: 'm1',
    wakeupId: 'w1',
    note: 'check the deploy',
    settledBy: 'timer',
    firedAt: new Date().toISOString(),
    ...overrides,
  });

  it('labels the reply that follows as a response to the wake-up [unit]', () => {
    render(<WakeupFiredMarker message={marker()} />);
    expect(screen.getByTestId('wakeup-fired-marker').textContent).toBe('Woke up: check the deploy');
  });

  it('says when the user triggered it early [unit]', () => {
    render(<WakeupFiredMarker message={marker({ settledBy: 'trigger_now' })} />);
    expect(screen.getByTestId('wakeup-fired-marker').textContent).toMatch(/triggered by you/);
  });
});
