import { describe, expect, it } from 'vitest';
import { swapHeaders, swapPlaceholders } from './placeholders.mjs';

const TOKEN = 'abc123';
const secrets = { STRIPE_API_KEY: 'sk_test_real', OTHER: 'o' };
const placeholder = (name, token = TOKEN) => `cocoon_${token}_${name}`;
const basic = (text) => `Basic ${Buffer.from(text).toString('base64')}`;

describe('swapPlaceholders', () => {
  it('replaces the placeholder of this sandbox and route', () => {
    expect(swapPlaceholders(`Bearer ${placeholder('STRIPE_API_KEY')}`, TOKEN, secrets)).toBe('Bearer sk_test_real');
  });

  it('leaves placeholders of other sandboxes and unknown secrets alone', () => {
    const foreign = placeholder('STRIPE_API_KEY', 'ffff');
    expect(swapPlaceholders(foreign, TOKEN, secrets)).toBe(foreign);
    expect(swapPlaceholders(placeholder('UNKNOWN'), TOKEN, secrets)).toBe(placeholder('UNKNOWN'));
  });
});

describe('swapHeaders', () => {
  it('swaps plain header values and keeps everything else', () => {
    const headers = swapHeaders({ authorization: `Bearer ${placeholder('STRIPE_API_KEY')}`, 'x-other': 'plain', 'content-length': 12 }, TOKEN, secrets);
    expect(headers).toEqual({ authorization: 'Bearer sk_test_real', 'x-other': 'plain', 'content-length': 12 });
  });

  it('swaps inside Basic credentials (key as user name)', () => {
    const headers = swapHeaders({ authorization: basic(`${placeholder('STRIPE_API_KEY')}:`) }, TOKEN, secrets);
    expect(Buffer.from(headers.authorization.slice(6), 'base64').toString()).toBe('sk_test_real:');
  });

  it('does not touch Basic credentials without placeholders or with foreign ones', () => {
    const plain = basic('user:pass');
    expect(swapHeaders({ authorization: plain }, TOKEN, secrets).authorization).toBe(plain);
    const foreign = basic(`${placeholder('STRIPE_API_KEY', 'ffff')}:`);
    expect(swapHeaders({ authorization: foreign }, TOKEN, secrets).authorization).toBe(foreign);
  });

  it('does not modify the input', () => {
    const input = { authorization: placeholder('STRIPE_API_KEY') };
    swapHeaders(input, TOKEN, secrets);
    expect(input.authorization).toBe(placeholder('STRIPE_API_KEY'));
  });
});
