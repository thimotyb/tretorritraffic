import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { streetSegments } from '../src/segments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, '..', 'data', 'traffic_samples.jsonl');
const BACKUP_FILE = path.resolve(__dirname, '..', 'data', 'traffic_samples.backup.jsonl');

const BPR_ALPHA = 0.15;
const BPR_BETA = 4;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function haversineDistanceMeters(a, b) {
  const R = 6371000; // Earth radius in meters
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(b.longitude - a.longitude);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);

  const calc = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(calc), Math.sqrt(1 - calc));
  return R * c;
}

export function computeSegmentLengthMeters(endpoints) {
  if (!endpoints || endpoints.length < 2) return null;
  let total = 0;
  for (let i = 0; i < endpoints.length - 1; i += 1) {
    total += haversineDistanceMeters(endpoints[i], endpoints[i + 1]);
  }
  return total;
}

const segmentMetadata = streetSegments.reduce((acc, segment) => {
  const { id, endpoints, metadata = {} } = segment;
  const lengthMeters = computeSegmentLengthMeters(endpoints);
  const lanes = metadata.lanes ?? 1;
  const laneCapacity = metadata.laneCapacityVph ?? 900;
  const capacityVph = lanes * laneCapacity;
  return acc.set(id, {
    id,
    lengthMeters,
    lanes,
    capacityVph,
    speedLimitKph: metadata.speedLimitKph ?? null,
  });
}, new Map());

export function deriveFlowMetrics(sample) {
  const meta = segmentMetadata.get(sample.segmentId);
  if (!meta) {
    return {
      capacityVph: null,
      lengthMeters: null,
      freeFlowSpeedKph: null,
      volumeCapacityRatio: null,
      derivedFlowVph: null,
      flowConfidence: 'low',
    };
  }

  const { lengthMeters, capacityVph } = meta;
  const duration = sample.durationSeconds ?? null;
  const staticDuration = sample.staticDurationSeconds ?? null;

  const freeFlowSpeedKph =
    lengthMeters != null && staticDuration && staticDuration > 0
      ? (lengthMeters / staticDuration) * 3.6
      : null;

  if (
    duration == null ||
    staticDuration == null ||
    duration <= 0 ||
    staticDuration <= 0 ||
    capacityVph == null ||
    capacityVph <= 0
  ) {
    return {
      capacityVph,
      lengthMeters,
      freeFlowSpeedKph,
      volumeCapacityRatio: null,
      derivedFlowVph: null,
      flowConfidence: 'low',
    };
  }

  // Ratio of observed to free-flow travel time
  const timeRatio = duration / staticDuration;
  let volumeCapacityRatio = 0;
  if (timeRatio > 1) {
    const adjusted = (timeRatio - 1) / BPR_ALPHA;
    volumeCapacityRatio = Math.pow(Math.max(adjusted, 0), 1 / BPR_BETA);
  }

  // Guard against extreme results
  if (!Number.isFinite(volumeCapacityRatio)) {
    volumeCapacityRatio = null;
  } else if (volumeCapacityRatio < 0) {
    volumeCapacityRatio = 0;
  }

  let derivedFlowVph = null;
  if (volumeCapacityRatio != null) {
    derivedFlowVph = volumeCapacityRatio * capacityVph;
    if (!Number.isFinite(derivedFlowVph)) {
      derivedFlowVph = null;
    }
  }

  let flowConfidence = 'medium';
  if (volumeCapacityRatio == null || derivedFlowVph == null) {
    flowConfidence = 'low';
  } else if (volumeCapacityRatio <= 0.8) {
    flowConfidence = 'high';
  } else if (volumeCapacityRatio > 1.2) {
    flowConfidence = 'low';
  }

  return {
    capacityVph,
    lengthMeters,
    freeFlowSpeedKph,
    volumeCapacityRatio,
    derivedFlowVph,
    flowConfidence,
  };
}

async function enrichSamples() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);

    const enrichedLines = lines.map((line) => {
      const sample = JSON.parse(line);
      const metrics = deriveFlowMetrics(sample);
      return JSON.stringify({
        ...sample,
        lengthMeters: metrics.lengthMeters,
        freeFlowSpeedKph: metrics.freeFlowSpeedKph,
        capacityVph: metrics.capacityVph,
        volumeCapacityRatio: metrics.volumeCapacityRatio,
        derivedFlowVph: metrics.derivedFlowVph,
        flowConfidence: metrics.flowConfidence,
        flowEstimationModel: {
          alpha: BPR_ALPHA,
          beta: BPR_BETA,
          source: 'BPR',
          notes: 'Derived from travel-time ratio using BPR function and assumed lane capacity.',
        },
      });
    });

    // Create backup once before overwriting
    await fs.writeFile(BACKUP_FILE, raw, 'utf8');
    await fs.writeFile(DATA_FILE, `${enrichedLines.join('\n')}\n`, 'utf8');

    console.log(
      `Enriched ${enrichedLines.length} samples with length, capacity, and flow estimates. Backup saved to ${path.relative(
        path.resolve(__dirname, '..'),
        BACKUP_FILE,
      )}`,
    );
  } catch (error) {
    console.error('Failed to enrich samples:', error);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  enrichSamples();
}
