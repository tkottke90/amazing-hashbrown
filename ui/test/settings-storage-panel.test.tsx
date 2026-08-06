import { fireEvent, render, screen, waitFor } from '@testing-library/preact';

jest.mock('@/services/settings-api', () => {
  class SettingsValidationError extends Error {
    fieldErrors: Record<string, string[]> | string;
    constructor(fe: Record<string, string[]> | string) { super('Validation failed'); this.name = 'SettingsValidationError'; this.fieldErrors = fe; }
  }
  return { SettingsValidationError, fetchSettingsSection: jest.fn(), patchSettingsSection: jest.fn() };
});
jest.mock('@/lib/toast', () => ({ showToast: jest.fn() }));

import { StoragePanel } from '@/components/settings/storage-panel';
import * as api from '@/services/settings-api';

const mockFetch = api.fetchSettingsSection as jest.MockedFunction<typeof api.fetchSettingsSection>;

const DEFAULT_DATA = {
  wikiRoot: './wiki',
  mcpConfigDir: './mcp',
  artifactRoot: './artifacts',
  skillsRoot: './skills',
  database: { path: 'app.db' },
};

describe('StoragePanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockResolvedValue(DEFAULT_DATA);
  });

  it('renders all 5 storage inputs after loading', async () => {
    render(<StoragePanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByLabelText('Wiki root')).toBeInTheDocument();
    expect(screen.getByLabelText('MCP config directory')).toBeInTheDocument();
    expect(screen.getByLabelText('Artifact root')).toBeInTheDocument();
    expect(screen.getByLabelText('Skills root')).toBeInTheDocument();
    expect(screen.getByLabelText('Database path')).toBeInTheDocument();
  });

  it('inputs show fetched values', async () => {
    render(<StoragePanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByLabelText<HTMLInputElement>('Wiki root').value).toBe('./wiki');
    expect(screen.getByLabelText<HTMLInputElement>('Database path').value).toBe('app.db');
  });

  it('Save/Discard bar appears after editing a field', async () => {
    render(<StoragePanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.queryByText('Save changes')).not.toBeInTheDocument();

    const wikiInput = screen.getByLabelText('Wiki root');
    fireEvent.input(wikiInput, { target: { value: '/new/wiki' } });

    await waitFor(() => expect(screen.getByText('Save changes')).toBeInTheDocument());
  });

  it('Discard resets field values to fetched state', async () => {
    render(<StoragePanel />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const wikiInput = screen.getByLabelText('Wiki root') as HTMLInputElement;
    fireEvent.input(wikiInput, { target: { value: '/changed' } });
    await waitFor(() => screen.getByText('Discard'));

    fireEvent.click(screen.getByText('Discard'));
    await waitFor(() => expect(wikiInput.value).toBe('./wiki'));
    expect(screen.queryByText('Save changes')).not.toBeInTheDocument();
  });
});
