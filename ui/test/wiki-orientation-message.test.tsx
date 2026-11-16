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
    // Scoped to the card's own text content rather than screen.getByText —
    // "user" legitimately appears twice (the badge and the sentence), which
    // makes an exact-text query ambiguous.
    const card = screen.getByTestId('wiki-orientation-card');
    expect(card.textContent).toContain('user');
    expect(card.textContent).toContain('user preferences, personal context, and biography');
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
    const card = screen.getByTestId('wiki-orientation-card');
    expect(card.textContent).not.toMatch(/## Schema/);
    expect(card.textContent).not.toMatch(/## Index/);
    expect(card.textContent).not.toMatch(/## Recent Log/);
  });
});
