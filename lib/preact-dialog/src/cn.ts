import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges Tailwind class strings, resolving conflicting utilities (e.g. two
 *  different `max-w-*` values) in favor of whichever argument comes last. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
