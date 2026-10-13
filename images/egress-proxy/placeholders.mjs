// Placeholder swapping of the credential proxy: "cocoon_<sandboxToken>_<SECRET>" → real value, only for the sandbox's own
// token and only for secrets of the route it calls. Also inside "Authorization: Basic <base64(user:password)>" headers
// (many APIs, e.g. Stripe, send the key as the user name).
const PLACEHOLDER = /cocoon_([a-f0-9]+)_([A-Z][A-Z0-9_]*)/g;

export function swapPlaceholders(text, sandboxToken, secrets) {
  return text.replace(PLACEHOLDER, (match, token, secret) => (token === sandboxToken && secrets[secret] !== undefined ? secrets[secret] : match));
}

/** Returns new headers with placeholders replaced (plain values and Basic credentials). */
export function swapHeaders(headers, sandboxToken, secrets) {
  const result = { ...headers };
  for (const [name, value] of Object.entries(result)) {
    if (typeof value !== 'string') continue;
    let swapped = swapPlaceholders(value, sandboxToken, secrets);
    const basic = /^(basic\s+)([A-Za-z0-9+/=_-]+)$/i.exec(swapped);
    if (basic) {
      const decoded = Buffer.from(basic[2], 'base64').toString('utf8');
      const inner = swapPlaceholders(decoded, sandboxToken, secrets);
      if (inner !== decoded) swapped = basic[1] + Buffer.from(inner, 'utf8').toString('base64');
    }
    result[name] = swapped;
  }
  return result;
}
