import { describe, it, expect } from 'vitest';

if (!process.env.GOOGLE_MAPS_API_KEY) {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
}

const { parseDurationSeconds, describeWeatherCode } = await import('../src/poller.js');

describe('parseDurationSeconds', () => {
  it('returns number for whole-second values', () => {
    expect(parseDurationSeconds('42s')).toBe(42);
  });

  it('parses fractional seconds', () => {
    expect(parseDurationSeconds('3.25s')).toBeCloseTo(3.25);
  });

  it('returns null for invalid input', () => {
    expect(parseDurationSeconds(null)).toBeNull();
    expect(parseDurationSeconds('abc')).toBeNull();
  });
});

describe('describeWeatherCode', () => {
  it('maps known codes to descriptions', () => {
    expect(describeWeatherCode(0)).toBe('Clear sky');
    expect(describeWeatherCode(65)).toBe('Heavy rain');
  });

  it('returns null for unknown or missing codes', () => {
    expect(describeWeatherCode(999)).toBeNull();
    expect(describeWeatherCode(undefined)).toBeNull();
  });
});
