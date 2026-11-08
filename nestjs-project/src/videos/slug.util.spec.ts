import { generateSlug } from './slug.util';

describe('generateSlug', () => {
  it('should return 11 characters', () => {
    expect(generateSlug()).toHaveLength(11);
  });

  it('should only use base62 characters', () => {
    for (let i = 0; i < 1000; i++) {
      expect(generateSlug()).toMatch(/^[0-9A-Za-z]{11}$/);
    }
  });

  it('should not repeat across 10,000 generations', () => {
    const slugs = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      slugs.add(generateSlug());
    }
    expect(slugs.size).toBe(10000);
  });
});
