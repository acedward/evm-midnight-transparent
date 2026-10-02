import { describe, expect, it } from 'vitest';

import { SPONSOR_VERSION } from '../src/version.js';

describe('sponsor version', () => {
  it('is a non-empty string', () => {
    expect(typeof SPONSOR_VERSION).toBe('string');
    expect(SPONSOR_VERSION.length).toBeGreaterThan(0);
  });
});
