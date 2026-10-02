import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/api-keys-api', () => ({
  listApiKeys: jest.fn(),
  createApiKey: jest.fn(),
  rotateApiKey: jest.fn(),
  revokeApiKey: jest.fn(),
}));
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { NotificationsPanel } from '@/pages/settings/notifications-panel';
import * as api from '@/services/api-keys-api';

const mockList = api.listApiKeys as jest.MockedFunction<typeof api.listApiKeys>;
const mockCreate = api.createApiKey as jest.MockedFunction<typeof api.createApiKey>;
const mockRotate = api.rotateApiKey as jest.MockedFunction<typeof api.rotateApiKey>;
const mockRevoke = api.revokeApiKey as jest.MockedFunction<typeof api.revokeApiKey>;

const KEY = {
  id: 'key-1',
  name: 'Zapier',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('NotificationsPanel', () => {
  const originalConfirm = global.confirm;

  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue([KEY]);
    global.confirm = jest.fn(() => true);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: jest.fn().mockResolvedValue(undefined) },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    global.confirm = originalConfirm;
  });

  it('renders the static webhook URL read-only, with a working copy button', async () => {
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const urlInput = screen.getByTestId('webhook-url') as HTMLInputElement;
    expect(urlInput.value).toContain('/api/v1/webhooks/tasks');

    fireEvent.click(screen.getByTestId('webhook-copy-button'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(urlInput.value));
  });

  it('renders a row for each existing API key', async () => {
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(screen.getByText('Zapier')).toBeInTheDocument();
  });

  it('shows empty state when no keys exist', async () => {
    mockList.mockResolvedValue([]);
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.getByText('No API keys yet.')).toBeInTheDocument());
  });

  it('creating a key calls createApiKey and reveals the returned secret', async () => {
    mockCreate.mockResolvedValue({ ...KEY, key: 'ahb_brandnewsecret' });
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.input(screen.getByPlaceholderText('Key name'), { target: { value: 'Zapier' } });
    fireEvent.click(screen.getByRole('button', { name: 'New key' }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith('Zapier'));
    await waitFor(() => expect(screen.getByDisplayValue('ahb_brandnewsecret')).toBeInTheDocument());
  });

  it('rotate asks for confirmation, calls rotateApiKey, and reveals the new secret', async () => {
    mockRotate.mockResolvedValue({ ...KEY, key: 'ahb_rotatedsecret' });
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(global.confirm).toHaveBeenCalled();
    await waitFor(() => expect(mockRotate).toHaveBeenCalledWith('key-1'));
    await waitFor(() => expect(screen.getByDisplayValue('ahb_rotatedsecret')).toBeInTheDocument());
  });

  it('rotate does nothing when confirmation is declined', async () => {
    global.confirm = jest.fn(() => false);
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(mockRotate).not.toHaveBeenCalled();
  });

  it('revoke asks for confirmation, calls revokeApiKey, and the row disappears', async () => {
    mockRevoke.mockResolvedValue(undefined);
    mockList.mockResolvedValueOnce([KEY]).mockResolvedValueOnce([]);
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(global.confirm).toHaveBeenCalled();
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('key-1'));
    await waitFor(() => expect(screen.queryByText('Zapier')).not.toBeInTheDocument());
  });

  it('revoke does nothing when confirmation is declined', async () => {
    global.confirm = jest.fn(() => false);
    render(<NotificationsPanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
