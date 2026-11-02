import { fireEvent, render, screen } from '@testing-library/preact';
import { WikiUpdateMessage } from '@/components/wiki-update-message';
import type { WikiUpdateThreadMessage } from '@/types/thread-message';

const mockRoute = jest.fn();
jest.mock('preact-iso', () => ({
  useLocation: () => ({ route: mockRoute }),
}));

function wikiUpdateMessage(
  overrides: Partial<WikiUpdateThreadMessage> = {},
): WikiUpdateThreadMessage {
  return {
    kind: 'wiki_update',
    id: 'w1',
    pageTitle: 'Router',
    pageKind: 'created',
    wikiName: 'homelab',
    path: 'entities/router.md',
    ...overrides,
  };
}

describe('WikiUpdateMessage', () => {
  beforeEach(() => {
    mockRoute.mockClear();
  });

  it('renders the wiki-name badge and page title', () => {
    render(<WikiUpdateMessage message={wikiUpdateMessage()} />);
    expect(screen.getByText('homelab')).toBeInTheDocument();
    expect(screen.getByText('Router')).toBeInTheDocument();
  });

  it('renders the Created/green badge for pageKind "created"', () => {
    render(<WikiUpdateMessage message={wikiUpdateMessage({ pageKind: 'created' })} />);
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('renders the Updated/amber badge for pageKind "updated"', () => {
    render(<WikiUpdateMessage message={wikiUpdateMessage({ pageKind: 'updated' })} />);
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('renders the Created/green badge (not blank) for a legacy pageKind value', () => {
    render(<WikiUpdateMessage message={wikiUpdateMessage({ pageKind: 'entity' })} />);
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.queryByText('Updated')).not.toBeInTheDocument();
  });

  it('navigates to the wiki document view when the Open link is clicked', () => {
    render(
      <WikiUpdateMessage
        message={wikiUpdateMessage({ wikiName: 'homelab', path: 'entities/router.md' })}
      />,
    );
    fireEvent.click(screen.getByTestId('wiki-update-open-link'));
    expect(mockRoute).toHaveBeenCalledWith(
      '/wiki?view=document&domain=homelab&page=entities%2Frouter.md',
    );
  });

  it('renders with no Open link and does not throw when path is absent', () => {
    render(<WikiUpdateMessage message={wikiUpdateMessage({ path: undefined })} />);
    expect(screen.queryByTestId('wiki-update-open-link')).not.toBeInTheDocument();
  });

  it('does not render the "Add to Message" button when onStageWikiReference is omitted', () => {
    render(<WikiUpdateMessage message={wikiUpdateMessage()} />);
    expect(screen.queryByTestId('wiki-update-add-to-message')).not.toBeInTheDocument();
  });

  it('does not render the "Add to Message" button when path is absent, even with onStageWikiReference set', () => {
    render(
      <WikiUpdateMessage
        message={wikiUpdateMessage({ path: undefined })}
        onStageWikiReference={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('wiki-update-add-to-message')).not.toBeInTheDocument();
  });

  it('calls onStageWikiReference with the card\'s own {wikiId, path, title} when "Add to Message" is clicked', () => {
    const onStageWikiReference = jest.fn();
    render(
      <WikiUpdateMessage
        message={wikiUpdateMessage({
          wikiName: 'homelab',
          path: 'entities/router.md',
          pageTitle: 'Router',
        })}
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

  it('renders a disabled "Added" state instead of "Add to Message" when isStaged is true', () => {
    const onStageWikiReference = jest.fn();
    render(
      <WikiUpdateMessage
        message={wikiUpdateMessage()}
        onStageWikiReference={onStageWikiReference}
        isStaged
      />,
    );
    const button = screen.getByTestId('wiki-update-add-to-message');
    expect(button).toBeDisabled();
    expect(screen.getByText('Added')).toBeInTheDocument();
    expect(screen.queryByText('Add to Message')).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(onStageWikiReference).not.toHaveBeenCalled();
  });
});
