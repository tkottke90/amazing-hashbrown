import { render, screen, fireEvent } from '@testing-library/preact';

jest.mock('@/pages/wiki/use-wiki-ingestion', () => ({
  sendWikiMessage: jest.fn(),
}));

import { NewDomainModal } from '@/pages/wiki/new-domain-form';

// Issue #397: iOS Safari zooms the page when a focused native control
// renders under 16px. These fields previously hardcoded text-xs; confirm
// each now renders at the mobile-safe text-base (16px) size.
describe('NewDomainModal — mobile-safe font sizes (issue #397)', () => {
  function expectMobileSafe(el: Element) {
    expect(el).toHaveClass('text-base', 'md:text-sm');
    expect(el.className).not.toMatch(/\btext-xs\b/);
  }

  it('renders the Domain ID, Description, and Routing notes fields at a mobile-safe size', () => {
    render(<NewDomainModal />);
    fireEvent.click(screen.getByText('New domain'));

    expectMobileSafe(screen.getByPlaceholderText('Domain ID (e.g. health-fitness)'));
    expectMobileSafe(screen.getByPlaceholderText('Description'));
    expectMobileSafe(screen.getByPlaceholderText('Routing notes (optional)'));
  });
});
