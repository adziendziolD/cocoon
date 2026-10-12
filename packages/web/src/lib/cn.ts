/** Joins class names, skipping falsy values. */
export function cn(...parts: Array<string | false | 0 | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
