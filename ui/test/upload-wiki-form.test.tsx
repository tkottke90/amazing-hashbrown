import { render, screen, fireEvent } from '@testing-library/preact';

jest.mock('@/services/wiki-api', () => ({
  ...jest.requireActual('@/services/wiki-api'),
  fetchUploadCapabilities: jest.fn().mockResolvedValue({ acceptedFormats: ['.tar.gz'] }),
}));

import { UploadWikiDialog } from '@/pages/wiki/upload-wiki-form';

// Issue #397: iOS Safari zooms the page when a focused native control
// renders under 16px. This field previously hardcoded text-xs; confirm it
// now renders at the mobile-safe text-base (16px) size.
describe('UploadWikiDialog — mobile-safe font sizes (issue #397)', () => {
  it('renders the Wiki ID field at a mobile-safe size', () => {
    render(<UploadWikiDialog />);
    fireEvent.click(screen.getByTitle('Upload Wiki'));

    const input = screen.getByPlaceholderText('Wiki ID (e.g. homelab)');
    expect(input).toHaveClass('text-base', 'md:text-sm');
    expect(input.className).not.toMatch(/\btext-xs\b/);
  });
});
