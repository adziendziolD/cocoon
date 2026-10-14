import { describe, expect, it } from 'vitest';
import { parseSkillSource } from './skills.ts';

describe('parseSkillSource', () => {
  it('parses owner/repo', () => {
    expect(parseSkillSource('acme/ponytail')).toEqual({ url: 'https://github.com/acme/ponytail', ref: undefined, path: undefined, name: 'ponytail' });
  });
  it('parses path and ref', () => {
    expect(parseSkillSource('acme/skills/tools/lint@v1')).toEqual({ url: 'https://github.com/acme/skills', ref: 'v1', path: 'tools/lint', name: 'lint' });
  });
  it('parses GitHub URLs', () => {
    expect(parseSkillSource('https://github.com/acme/skills.git')?.url).toBe('https://github.com/acme/skills');
    expect(parseSkillSource('https://github.com/acme/skills/tree/main/a/b')).toMatchObject({ ref: 'main', path: 'a/b', name: 'b' });
  });
  it('rejects invalid input', () => {
    for (const bad of ['', 'acme', 'acme/../x', 'a/b/c d', 'https://gitlab.com/a/b;rm']) expect(parseSkillSource(bad)).toBeUndefined();
  });
});
