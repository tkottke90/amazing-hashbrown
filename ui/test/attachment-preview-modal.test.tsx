import { render, screen } from '@testing-library/preact';

import { AttachmentPreviewModal } from '@/components/attachment-preview-modal';

describe('AttachmentPreviewModal', () => {
  it('renders a full-size image lightbox for an image attachment', () => {
    render(
      <AttachmentPreviewModal
        attachment={{ id: 'a1', filename: 'photo.png', mimeType: 'image/png' }}
      />,
    );
    const images = screen.getAllByAltText('photo.png') as HTMLImageElement[];
    const lightbox = images.find((img) => img.className.includes('object-contain'));
    expect(lightbox?.src).toContain('/api/v1/artifacts/a1');
  });

  it('renders a video lightbox with controls for a video attachment', () => {
    render(
      <AttachmentPreviewModal
        attachment={{ id: 'a1', filename: 'clip.mp4', mimeType: 'video/mp4' }}
      />,
    );
    const video = document.querySelector('video[controls]') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.src).toContain('/api/v1/artifacts/a1');
  });

  it('renders a download link with the correct href and download attribute for a non-media attachment', () => {
    render(
      <AttachmentPreviewModal
        attachment={{ id: 'a1', filename: 'notes.txt', mimeType: 'text/plain' }}
      />,
    );
    const link = screen.getByRole('link', { name: /download/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/api/v1/artifacts/a1');
    expect(link.getAttribute('download')).toBe('notes.txt');
  });

  it("passes the tile's filename and mimeType through to its trigger", () => {
    render(
      <AttachmentPreviewModal
        attachment={{ id: 'a1', filename: 'notes.txt', mimeType: 'text/plain' }}
      />,
    );
    const tile = document.querySelector('[data-slot="chat-message-attachment"]');
    expect(tile).not.toBeNull();
    expect(tile?.querySelector('button')).toHaveAttribute('title', 'notes.txt');
  });
});
