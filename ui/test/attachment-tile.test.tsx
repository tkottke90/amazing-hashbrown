import { fireEvent, render, screen, within } from '@testing-library/preact';

import { AttachmentTile } from '@/components/attachment-tile';
import { TooltipProvider } from '@/components/ui/tooltip';

function tile() {
  return document.querySelector('[data-slot="chat-message-attachment"]') as HTMLElement;
}

describe('AttachmentTile', () => {
  it('renders an image sourced from the artifacts endpoint for an image mimeType', () => {
    render(<AttachmentTile id="a1" filename="photo.png" mimeType="image/png" />);
    const img = within(tile()).getByAltText('photo.png') as HTMLImageElement;
    expect(img.src).toContain('/api/v1/artifacts/a1');
  });

  it('renders a video sourced from the artifacts endpoint for a video mimeType', () => {
    render(<AttachmentTile id="a1" filename="clip.mp4" mimeType="video/mp4" />);
    const video = tile().querySelector('video') as HTMLVideoElement;
    expect(video).not.toBeNull();
    expect(video.src).toContain('/api/v1/artifacts/a1');
  });

  it('renders a colored extension box for a non-image, non-video mimeType', () => {
    render(<AttachmentTile id="a1" filename="notes.pdf" mimeType="application/pdf" />);
    expect(within(tile()).getByText('PDF')).toHaveClass('bg-rose-100');
  });

  it('shows a blurred local preview underneath the remote image until it loads, then removes it', () => {
    render(
      <AttachmentTile
        id="a1"
        filename="photo.png"
        mimeType="image/png"
        previewUrl="blob:local-preview"
      />,
    );
    const images = Array.from(tile().querySelectorAll('img')) as HTMLImageElement[];
    const blurred = images.find((img) => img.src.includes('blob:local-preview'));
    const remote = images.find((img) => img.src.includes('/api/v1/artifacts/a1'));
    expect(blurred).toBeDefined();
    expect(blurred).toHaveClass('blur-sm');
    expect(remote).toHaveClass('opacity-0');

    fireEvent.load(remote!);

    expect(remote).toHaveClass('opacity-100');
    expect(
      Array.from(tile().querySelectorAll('img')).some((img) =>
        (img as HTMLImageElement).src.includes('blob:local-preview'),
      ),
    ).toBe(false);
  });

  it('falls back to the extension box when the remote image fails to load', () => {
    render(<AttachmentTile id="a1" filename="photo.png" mimeType="image/png" />);
    const img = within(tile()).getByAltText('photo.png');
    fireEvent.error(img);

    expect(within(tile()).queryByAltText('photo.png')).toBeNull();
    expect(within(tile()).getByText('PNG')).toBeInTheDocument();
  });

  it('shows no excluded badge when excluded is unset (not yet resolved)', () => {
    render(<AttachmentTile id="a1" filename="photo.png" mimeType="image/png" />);
    expect(screen.queryByRole('button', { name: /not processed/i })).toBeNull();
  });

  it('shows the excluded badge with a tooltip when excluded is true', () => {
    render(
      <TooltipProvider>
        <AttachmentTile
          id="a1"
          filename="photo.png"
          mimeType="image/png"
          excluded
          exclusionReason="vision_unsupported"
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: /not processed/i })).toBeInTheDocument();
  });
});
