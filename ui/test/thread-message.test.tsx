import { fireEvent, render, screen } from '@testing-library/preact';
import { ThreadMessageItem } from '@/components/thread-message';
import type { ThreadMessage } from '@/types/thread-message';

jest.mock('preact-iso', () => ({
  useLocation: () => ({ route: jest.fn() }),
}));

function wikiUpdateMessage(overrides: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    kind: 'wiki_update',
    id: 'w1',
    pageTitle: 'Router',
    pageKind: 'created',
    wikiName: 'homelab',
    path: 'entities/router.md',
    ...overrides,
  } as ThreadMessage;
}

describe('ThreadMessageItem — wiki_update prop threading', () => {
  it('passes onStageWikiReference through to the WikiUpdateMessage card', () => {
    const onStageWikiReference = jest.fn();
    render(
      <ThreadMessageItem
        message={wikiUpdateMessage()}
        onHitlAnswer={jest.fn()}
        onStageWikiReference={onStageWikiReference}
      />,
    );

    fireEvent.click(screen.getByTestId('wiki-update-add-to-message'));
    expect(onStageWikiReference).toHaveBeenCalledWith({
      wikiId: 'homelab',
      path: 'entities/router.md',
      title: 'Router',
    });
  });

  it('does not render the Add to Message button when onStageWikiReference is omitted', () => {
    render(<ThreadMessageItem message={wikiUpdateMessage()} onHitlAnswer={jest.fn()} />);
    expect(screen.queryByTestId('wiki-update-add-to-message')).not.toBeInTheDocument();
  });

  it('computes isStaged from stagedWikiReferenceKeys, keyed `${wikiName}:${path}`', () => {
    render(
      <ThreadMessageItem
        message={wikiUpdateMessage()}
        onHitlAnswer={jest.fn()}
        onStageWikiReference={jest.fn()}
        stagedWikiReferenceKeys={new Set(['homelab:entities/router.md'])}
      />,
    );

    expect(screen.getByTestId('wiki-update-add-to-message')).toBeDisabled();
    expect(screen.getByText('Added')).toBeInTheDocument();
  });

  it('is not staged when the key set does not contain this card\'s own key', () => {
    render(
      <ThreadMessageItem
        message={wikiUpdateMessage()}
        onHitlAnswer={jest.fn()}
        onStageWikiReference={jest.fn()}
        stagedWikiReferenceKeys={new Set(['homelab:entities/switch.md'])}
      />,
    );

    expect(screen.getByTestId('wiki-update-add-to-message')).not.toBeDisabled();
    expect(screen.getByText('Add to Message')).toBeInTheDocument();
  });
});
