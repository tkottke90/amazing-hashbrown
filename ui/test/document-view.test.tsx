import { render, screen, fireEvent } from '@testing-library/preact';

import { DocumentView } from '@/pages/wiki/document-view';
import { domains, activeDomainId, pageList, activePage } from '@/pages/wiki/use-wiki';
import { wikiOrientedTo } from '@/pages/wiki/use-wiki-ingestion';
import type { WikiDomain, WikiPageContent } from '@/services/wiki-api';

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

// Issue #397: iOS Safari zooms the page when a focused native control
// renders under 16px. These controls previously hardcoded text-xs;
// confirm each now renders at the mobile-safe text-base (16px) size.
describe('DocumentView — mobile-safe font sizes (issue #397)', () => {
  const PAGE: WikiPageContent = {
    filename: 'notes.md',
    title: 'Notes',
    type: 'reference',
    frontmatter: {},
    content: 'hello',
  };

  afterEach(() => {
    domains.value = [];
    activeDomainId.value = null;
    pageList.value = [];
    activePage.value = null;
    jest.clearAllMocks();
  });

  function expectMobileSafe(el: Element) {
    expect(el).toHaveClass('text-base', 'md:text-sm');
    expect(el.className).not.toMatch(/\btext-xs\b/);
  }

  it('renders the sidebar domain selector at a mobile-safe size', () => {
    domains.value = [DOMAIN];
    activeDomainId.value = DOMAIN.id;
    render(<DocumentView />);

    const selects = document.querySelectorAll('select');
    expectMobileSafe(selects[0] as Element);
  });

  it('renders the New Page form fields at a mobile-safe size', () => {
    domains.value = [DOMAIN];
    activeDomainId.value = DOMAIN.id;
    render(<DocumentView />);

    fireEvent.click(screen.getByRole('button', { name: /new page/i }));

    expectMobileSafe(screen.getByPlaceholderText('Title'));
    expectMobileSafe(screen.getByPlaceholderText('Initial content (optional)'));
    const selects = document.querySelectorAll('select');
    // selects[0] is the sidebar domain selector; selects[1] is the new-page type picker.
    expectMobileSafe(selects[1] as Element);
  });

  it('renders the full-page markdown editor textarea at a mobile-safe size', () => {
    domains.value = [DOMAIN];
    activeDomainId.value = DOMAIN.id;
    pageList.value = [
      { filename: PAGE.filename, title: PAGE.title, type: PAGE.type, tags: [] },
    ];
    activePage.value = PAGE;
    render(<DocumentView />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const editor = document.querySelector('textarea') as HTMLTextAreaElement;
    expectMobileSafe(editor);
    // Not migrated to the shared Textarea primitive (deliberately chromeless
    // editor — see the design spec's Pattern A) — confirm the existing
    // border-0/h-full layout survived the font-size-only patch.
    expect(editor).toHaveClass('border-0', 'h-full');
  });
});
