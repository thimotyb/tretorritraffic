import { describe, it, expect } from 'vitest';
import { streetSegments } from '../src/segments.js';

const VALID_DIRECTIONS = new Set(['forward', 'reverse']);

describe('street segment configuration', () => {
  it('only lists valid allowed directions when specified', () => {
    for (const segment of streetSegments) {
      const allowed = segment?.metadata?.allowedDirections;
      if (allowed == null) continue;
      expect(Array.isArray(allowed)).toBe(true);
      expect(allowed.length).toBeGreaterThan(0);
      for (const entry of allowed) {
        expect(VALID_DIRECTIONS.has(entry)).toBe(true);
      }
    }
  });
});
