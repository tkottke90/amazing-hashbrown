import { render, screen, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Tracker } from '@/services/trackers-api';

const mockListTrackers = jest.fn();
jest.mock('@/services/trackers-api', () => ({
  ...jest.requireActual('@/services/trackers-api'),
  listTrackers: () => mockListTrackers(),
}));

jest.mock('@/pages/settings/use-settings-section', () => ({
  useSettingsSection: () => ({
    form: signal({}),
    isDirty: signal(false),
    isSaving: signal(false),
    fetchError: signal(null),
    setField: jest.fn(),
    save: jest.fn(),
    discard: jest.fn(),
  }),
}));

import { TrackersSection } from '@/pages/settings/trackers-section';

function tracker(overrides: Partial<Tracker>): Tracker {
  return {
    type: 'todoist',
    displayName: 'Todoist',
    icon: '',
    canCreate: false,
    configured: false,
    authSchema: [{ key: 'token', label: 'API token', type: 'password', required: true }],
    ...overrides,
  };
}

async function rowFor(name: string) {
  const label = await screen.findByText(name);
  return within(label.closest('[data-slot="tracker-row"]') as HTMLElement);
}

describe('TrackersSection', () => {
  it('marks a tracker without credentials as Not configured, and still lets it be configured [unit]', async () => {
    mockListTrackers.mockResolvedValueOnce([tracker({})]);
    render(<TrackersSection />);
    const row = await rowFor('Todoist');
    expect(row.getByText('Not configured')).toBeInTheDocument();
    expect(row.getByRole('button', { name: 'Configure' })).toBeInTheDocument();
  });

  it('shows Link & create for a configured tracker that can create items [unit]', async () => {
    mockListTrackers.mockResolvedValueOnce([tracker({ configured: true, canCreate: true })]);
    render(<TrackersSection />);
    const row = await rowFor('Todoist');
    expect(row.getByText('Link & create')).toBeInTheDocument();
    expect(row.queryByText('Not configured')).toBeNull();
  });
});
