import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  computeSegmentLengthMeters,
  deriveFlowMetrics,
  refreshSegmentMetadata,
} from '../scripts/enrich_flows.js';
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
  let customSegment;

  beforeAll(() => {
    customSegment = {
      id: 'test-flow-model-segment',
      name: 'Test Flow Model Segment',
      endpoints: [
        { latitude: 45.0, longitude: 9.0 },
        { latitude: 45.0, longitude: 9.001 },
      ],
      metadata: {
        lanes: 1,
        laneCapacityVph: 1000,
        flowModel: {
          alpha: 0.3,
          beta: 3,
        },
      },
    };
    streetSegments.push(customSegment);
    refreshSegmentMetadata();
  });

  afterAll(() => {
    const index = streetSegments.findIndex((segment) => segment.id === customSegment.id);
    if (index >= 0) {
      streetSegments.splice(index, 1);
    }
    refreshSegmentMetadata();
  });

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

  it('uses per-segment BPR parameters when provided', () => {
    const durationSeconds = 90;
    const staticDurationSeconds = 60;
    const sample = {
      segmentId: customSegment.id,
      durationSeconds,
      staticDurationSeconds,
    };

    const metrics = deriveFlowMetrics(sample);

    expect(metrics.alpha).toBeCloseTo(0.3);
    expect(metrics.beta).toBeCloseTo(3);

    const timeRatio = durationSeconds / staticDurationSeconds;
    const expectedVcr = Math.pow((timeRatio - 1) / 0.3, 1 / 3);
    expect(metrics.volumeCapacityRatio).toBeCloseTo(expectedVcr);
    expect(metrics.derivedFlowVph).toBeCloseTo(expectedVcr * 1000);
  });
});
