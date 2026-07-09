import sharp from 'sharp';

export interface ProcessedImage {
  web: Buffer; // WebP ≤1200px wide, quality 82
  preview: Buffer; // 32px wide JPEG, for blur-up placeholder
}

export async function processImage(input: Buffer): Promise<ProcessedImage> {
  const [web, preview] = await Promise.all([
    sharp(input).resize({ width: 1200, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer(),

    sharp(input).resize({ width: 32, withoutEnlargement: true }).jpeg({ quality: 20 }).toBuffer(),
  ]);

  return { web, preview };
}
