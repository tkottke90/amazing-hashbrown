import { render, screen } from '@testing-library/preact';
import { WikiOrientationMessage } from '@/components/wiki-orientation-message';
import type { WikiOrientationThreadMessage } from '@/types/thread-message';

function setMessage(
  overrides: Partial<WikiOrientationThreadMessage> = {},
): WikiOrientationThreadMessage {
  return {
    kind: 'wiki_orientation',
    id: 'o1',
    action: 'set',
    wikiId: 'user',
    wikiDescription: 'user preferences, personal context, and biography',
    ...overrides,
  };
}

describe('WikiOrientationMessage', () => {
  it('renders the wiki id and description for action: set', () => {
    render(<WikiOrientationMessage message={setMessage()} />);
    expect(screen.getByText('user')).toBeInTheDocument();
    expect(
      screen.getByText((_, node) =>
        (node?.textContent ?? '').includes('user preferences, personal context, and biography'),
      ),
    ).toBeInTheDocument();
  });

  it('renders the muted cleared-state line for action: cleared', () => {
    render(
      <WikiOrientationMessage
        message={setMessage({ action: 'cleared', wikiId: undefined, wikiDescription: undefined })}
      />,
    );
    expect(screen.getByText('No longer oriented to a wiki')).toBeInTheDocument();
  });

  it('never renders anything resembling schema/index/log content', () => {
    render(<WikiOrientationMessage message={setMessage()} />);
    expect(screen.queryByText(/## Schema/)).not.toBeInTheDocument();
    expect(screen.queryByText(/## Index/)).not.toBeInTheDocument();
    expect(screen.queryByText(/## Recent Log/)).not.toBeInTheDocument();
  });
});
