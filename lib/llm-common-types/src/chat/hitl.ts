import { z } from 'zod';

export const HitlKindSchema = z.enum(['yes_no', 'multiple_choice', 'free_text', 'shell_approval']);
export type HitlKind = z.infer<typeof HitlKindSchema>;
