import { z } from 'zod';

export const HitlKindSchema = z.enum(['yes_no', 'multiple_choice', 'free_text']);
export type HitlKind = z.infer<typeof HitlKindSchema>;
