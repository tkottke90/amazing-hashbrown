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
    .describe('Descriptive alt text shown in the caption bar and for screen readers'),
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
    const hash = nsfw ? '#nsfw' : '';

    return `![${alt ?? 'Image'}](/api/v1/artifacts/${id}${hash})`;
  },
  {
    name: 'upload_image',
    description:
      'Process and store an image, then get back a standard Markdown image link you can ' +
      'embed directly in your response. The image is automatically optimised for the web. ' +
      'Pass raw base64 bytes (no data: URI prefix), the MIME type, and an optional alt text. ' +
      'Set nsfw: true for sensitive images — they will be blurred until the user reveals them.',
    schema: UploadImageSchema,
  },
);
