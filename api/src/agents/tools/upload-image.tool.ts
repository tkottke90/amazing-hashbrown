import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { storeArtifact } from '../../artifacts/artifact-store.js';

const UploadImageSchema = z.object({
  imageBase64: z.string().describe('Base64-encoded image bytes (no data: URI prefix)'),
  mimeType: z
    .string()
    .describe('MIME type of the image, e.g. "image/png" or "image/jpeg"'),
  altText: z
    .string()
    .optional()
    .describe('Descriptive alt text for the image (shown while loading and for screen readers)'),
});

export const uploadImageTool = tool(
  async ({ imageBase64, mimeType, altText }: z.infer<typeof UploadImageSchema>) => {
    const buffer = Buffer.from(imageBase64, 'base64');
    const id = storeArtifact(buffer, mimeType);
    const alt = altText ?? 'Image';
    return `![${alt}](/api/v1/artifacts/${id})`;
  },
  {
    name: 'upload_image',
    description:
      'Store an image on the server and get back a Markdown image snippet you can embed ' +
      'directly in your response. The image will appear inline where you place the snippet. ' +
      'Pass raw base64 bytes (no data: URI prefix) and the MIME type.',
    schema: UploadImageSchema,
  },
);
