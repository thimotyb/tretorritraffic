import { describe, it, expect } from 'vitest';
import { computeSegmentLengthMeters, deriveFlowMetrics } from '../scripts/enrich_flows.js';
import { streetSegments } from '../src/segments.js';

describe('computeSegmentLengthMeters', () => {
  it('returns total haversine distance across endpoints', () => {
    const segment = streetSegments.find((item) => item.id === 'via-pontida');
    const length = computeSegmentLengthMeters(segment.endpoints);
    expect(length).toBeGreaterThan(300);
    expect(length).toBeLessThan(400);
  });

  it('returns null for insufficient endpoints', () => {
    expect(computeSegmentLengthMeters([{ latitude: 0, longitude: 0 }])).toBeNull();
  });
});

describe('deriveFlowMetrics', () => {
  it('derives flow metrics for valid samples', () => {
    const sample = {
      segmentId: 'via-pontida',
      durationSeconds: 90,
      staticDurationSeconds: 60
    };

    const metrics = deriveFlowMetrics(sample);

    expect(metrics.capacityVph).toBe(750);
    expect(metrics.lengthMeters).toBeGreaterThan(300);
    expect(metrics.lengthMeters).toBeLessThan(400);
    expect(metrics.freeFlowSpeedKph).toBeGreaterThan(15);
    expect(metrics.volumeCapacityRatio).toBeGreaterThan(1);
    expect(metrics.derivedFlowVph).toBeGreaterThan(900);
    expect(metrics.flowConfidence).toBe('low');
  });

  it('handles missing durations gracefully', () => {
    const metrics = deriveFlowMetrics({
      segmentId: 'via-pontida',
      durationSeconds: null,
      staticDurationSeconds: null
    });

    expect(metrics.volumeCapacityRatio).toBeNull();
    expect(metrics.derivedFlowVph).toBeNull();
    expect(metrics.flowConfidence).toBe('low');
  });
});
