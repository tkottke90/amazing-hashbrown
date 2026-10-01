import { render, screen, fireEvent } from '@testing-library/preact';

import { DocumentView } from '@/pages/wiki/document-view';
import { domains, activeDomainId, pageList, activePage } from '@/pages/wiki/use-wiki';
import { wikiOrientedTo } from '@/pages/wiki/use-wiki-ingestion';
import type { WikiDomain } from '@/services/wiki-api';

jest.mock('@/pages/wiki/use-wiki', () => ({
  ...jest.requireActual('@/pages/wiki/use-wiki'),
  refreshPages: jest.fn(),
  loadPage: jest.fn(),
}));

jest.mock('@/pages/wiki/use-wiki-ingestion', () => ({
  ...jest.requireActual('@/pages/wiki/use-wiki-ingestion'),
  sendWikiMessage: jest.fn(),
  newWikiThread: jest.fn(),
}));

import { sendWikiMessage, newWikiThread } from '@/pages/wiki/use-wiki-ingestion';

const sendWikiMessageMock = sendWikiMessage as jest.MockedFunction<typeof sendWikiMessage>;
const newWikiThreadMock = newWikiThread as jest.MockedFunction<typeof newWikiThread>;

const DOMAIN: WikiDomain = { id: 'homelab', domain: 'infrastructure', tags: [] };

describe('DocumentView Focus Wiki button', () => {
  afterEach(() => {
    domains.value = [];
    activeDomainId.value = null;
    pageList.value = [];
    activePage.value = null;
    wikiOrientedTo.value = null;
    jest.clearAllMocks();
  });

  it('is disabled when no domain is selected', () => {
    domains.value = [];
    activeDomainId.value = null;
    render(<DocumentView />);

    expect(screen.getByRole('button', { name: /focus wiki/i })).toBeDisabled();
  });

  it('starts a new thread and sends the canned orientation prompt when clicked', () => {
    domains.value = [DOMAIN];
    activeDomainId.value = DOMAIN.id;
    render(<DocumentView />);

    const button = screen.getByRole('button', { name: /focus wiki/i });
    expect(button).toBeEnabled();

    fireEvent.click(button);

    expect(newWikiThreadMock).toHaveBeenCalledTimes(1);
    expect(sendWikiMessageMock).toHaveBeenCalledTimes(1);
    expect(sendWikiMessageMock).toHaveBeenCalledWith(`Orient to the ${DOMAIN.id} wiki.`);
  });

  it('is not highlighted as active when the oriented wiki differs from the selected domain', () => {
    domains.value = [DOMAIN];
    activeDomainId.value = DOMAIN.id;
    wikiOrientedTo.value = 'some-other-wiki';
    render(<DocumentView />);

    expect(screen.getByRole('button', { name: /focus wiki/i })).not.toHaveClass(
      'bg-sidebar-accent',
    );
  });

  it('is highlighted as active once the selected domain is the oriented wiki', () => {
    domains.value = [DOMAIN];
    activeDomainId.value = DOMAIN.id;
    wikiOrientedTo.value = DOMAIN.id;
    render(<DocumentView />);

    expect(screen.getByRole('button', { name: /focus wiki/i })).toHaveClass('bg-sidebar-accent');
  });
});
