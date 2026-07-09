import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { storeArtifact } from '../../artifacts/artifact-store.js';
import { processImage } from '../../artifacts/image-processor.js';

const UploadImageSchema = z.object({
  imageBase64: z.string().describe('Base64-encoded image bytes (no data: URI prefix)'),
  mimeType: z.string().describe('MIME type of the image, e.g. "image/png" or "image/jpeg"'),
  alt: z
    .string()
    .optional()
    .describe('Descriptive alt text shown while loading and for screen readers'),
  nsfw: z
    .boolean()
    .optional()
    .describe('Mark the image as sensitive; it will be blurred until the user clicks to reveal'),
});

export const uploadImageTool = tool(
  async ({ imageBase64, mimeType, alt, nsfw }: z.infer<typeof UploadImageSchema>) => {
    const original = Buffer.from(imageBase64, 'base64');
    const { web, preview } = await processImage(original);

    const id = storeArtifact({ mimeType, original, web, preview });

    const lines = [`id: ${id}`];
    if (alt) lines.push(`alt: ${alt}`);
    if (nsfw) lines.push(`nsfw: true`);

    return '```image\n' + lines.join('\n') + '\n```';
  },
  {
    name: 'upload_image',
    description:
      'Process and store an image, then get back a Markdown image block you can embed ' +
      'directly in your response. The image is optimised for the web automatically. ' +
      'Pass raw base64 bytes (no data: URI prefix), the MIME type, and an optional alt text. ' +
      'Set nsfw: true for sensitive images — they will be blurred until the user reveals them.',
    schema: UploadImageSchema,
  },
);
