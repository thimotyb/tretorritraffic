import fs from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import { streetSegments } from "./segments.js";

dotenv.config();

const fetchImpl = globalThis.fetch ?? (await import("node-fetch")).default;

const GOOGLE_ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";
const FIELD_MASK = [
  "routes.duration",
  "routes.distanceMeters",
  "routes.staticDuration",
  "routes.travelAdvisory",
  "routes.routeLabels"
].join(",");

const DEPARTURE_LEAD_SECONDS = 120;
const DEFAULT_DELAY_MS = 250;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "traffic_samples.jsonl");

const apiKey = process.env.GOOGLE_MAPS_API_KEY;
if (!apiKey) {
  throw new Error("GOOGLE_MAPS_API_KEY missing. Set it in your environment or .env file.");
}

function parseDurationSeconds(duration) {
  if (!duration) return null;
  const match = duration.match(/([0-9]+)(?:\.([0-9]+))?s/);
  if (!match) return null;
  const integer = Number(match[1]);
  const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
  return integer + fraction;
}

function buildRequestBody(origin, destination) {
  return {
    origin: {
      location: {
        latLng: {
          latitude: origin.latitude,
          longitude: origin.longitude
        }
      }
    },
    destination: {
      location: {
        latLng: {
          latitude: destination.latitude,
          longitude: destination.longitude
        }
      }
    },
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    departureTime: {
      seconds: Math.floor(Date.now() / 1000) + DEPARTURE_LEAD_SECONDS
    }
  };
}

async function fetchTravelTime({ segment, direction }) {
  const [forward, reverse] = segment.endpoints;
  const origin = direction === "forward" ? forward : reverse;
  const destination = direction === "forward" ? reverse : forward;
  const body = buildRequestBody(origin, destination);

  const response = await fetchImpl(GOOGLE_ROUTES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorPayload = await response.text();
    throw new Error(
      `Google Routes API error (${response.status} ${response.statusText}) for ${segment.id} ${direction}: ${errorPayload}`
    );
  }

  const json = await response.json();
  const route = json?.routes?.[0];
  if (!route) {
    throw new Error(`No route returned for ${segment.id} ${direction}`);
  }

  const travelAdvisory = route.travelAdvisory ?? {};

  return {
    segmentId: segment.id,
    segmentName: segment.name,
    direction,
    requestedAt: new Date().toISOString(),
    origin,
    destination,
    distanceMeters: route.distanceMeters ?? null,
    durationSeconds: parseDurationSeconds(route.duration),
    staticDurationSeconds: parseDurationSeconds(route.staticDuration),
    delaySeconds: parseDurationSeconds(travelAdvisory.delayDuration),
    speedReadingIntervals: travelAdvisory.speedReadingIntervals ?? null,
    routeLabels: route.routeLabels ?? null
  };
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function appendSamples(samples) {
  const lines = samples.map((sample) => JSON.stringify(sample));
  await fs.appendFile(DATA_FILE, `${lines.join("\n")}\n`, "utf8");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function collectSamples({
  delayMs = DEFAULT_DELAY_MS,
  logProgress = true,
  logErrors = true
} = {}) {
  await ensureDataDir();

  const samples = [];

  for (const segment of streetSegments) {
    for (const direction of ["forward", "reverse"]) {
      try {
        const sample = await fetchTravelTime({ segment, direction });
        samples.push(sample);
        if (logProgress) {
          console.log(
            `${segment.name} (${direction}) → duration ${sample.durationSeconds ?? "n/a"}s, delay ${
              sample.delaySeconds ?? "n/a"
            }s`
          );
        }
      } catch (error) {
        if (logErrors) {
          console.error(`Failed to collect ${segment.id} ${direction}:`, error.message);
        }
      }

      if (delayMs > 0) {
        await wait(delayMs);
      }
    }
  }

  if (samples.length > 0) {
    await appendSamples(samples);
    if (logProgress) {
      console.log(
        `Appended ${samples.length} samples to ${path.relative(process.cwd(), DATA_FILE)}`
      );
    }
  } else if (logProgress) {
    console.warn("No samples collected. Nothing written to disk.");
  }

  return {
    samples,
    dataFile: DATA_FILE
  };
}

async function main() {
  try {
    await collectSamples();
  } catch (error) {
    console.error("Fatal error", error);
    process.exit(1);
  }
}

const executedDirectly = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;

if (executedDirectly) {
  main();
}
