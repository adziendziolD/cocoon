// Linear-time replacements for regular expressions such as /\/+$/ or /[?#].*$/. Those backtrack quadratically on long
// runs of the same character (a URL of many slashes, a line of many spaces), and their input comes from API callers or
// from files an agent wrote: a long string could block the server's event loop.

/** Removes every `char` (one character) at the end of the text. */
export function trimTrailing(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return end === text.length ? text : text.slice(0, end);
}

/** The text up to (excluding) the first of the given characters. */
export function cutAtAny(text: string, chars: string): string {
  for (let i = 0; i < text.length; i++) if (chars.includes(text[i]!)) return text.slice(0, i);
  return text;
}

/** The text without a trailing " # comment" (a `#` that follows whitespace) and without the whitespace before it. */
export function stripInlineComment(text: string): string {
  for (let i = text.indexOf('#'); i > 0; i = text.indexOf('#', i + 1)) {
    if (/\s/.test(text[i - 1]!)) return text.slice(0, i).trimEnd();
  }
  return text;
}

/** Removes a Markdown code fence (```json … ```) around the text, if there is one. */
export function stripCodeFence(text: string): string {
  let out = text.trim();
  if (out.startsWith('```')) out = out.slice(3).replace(/^json/, '').trimStart();
  if (out.endsWith('```')) out = out.slice(0, -3).trimEnd();
  return out;
}
