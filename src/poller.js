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
const WEATHER_LATITUDE = 45.5189;
const WEATHER_LONGITUDE = 9.3247;
const WEATHER_URL =
  `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_LATITUDE}&longitude=${WEATHER_LONGITUDE}` +
  '&current=temperature_2m,weather_code&timezone=auto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "traffic_samples.jsonl");

const apiKey = process.env.GOOGLE_MAPS_API_KEY;
if (!apiKey) {
  throw new Error("GOOGLE_MAPS_API_KEY missing. Set it in your environment or .env file.");
}

export function parseDurationSeconds(duration) {
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

export function describeWeatherCode(code) {
  if (code == null || Number.isNaN(code)) return null;
  const lookup = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snowfall",
    73: "Moderate snowfall",
    75: "Heavy snowfall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with slight hail",
    99: "Thunderstorm with heavy hail"
  };
  return lookup[code] ?? null;
}

async function fetchWeatherSnapshot() {
  try {
    const response = await fetchImpl(WEATHER_URL, {
      method: "GET",
      headers: {
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Weather API error ${response.status}`);
    }

    const data = await response.json();
    const current = data?.current;
    if (!current) return null;

    const weatherCode = Number(current.weather_code ?? current.weatherCode ?? null);
    const temperatureC =
      typeof current.temperature_2m === "number" ? current.temperature_2m : null;
    const timeValue = current.time ?? null;

    return {
      weatherCode,
      condition: describeWeatherCode(weatherCode),
      temperatureC,
      observedAt: timeValue ? new Date(timeValue).toISOString() : new Date().toISOString(),
      provider: "open-meteo"
    };
  } catch (error) {
    console.warn("Failed to fetch weather snapshot:", error?.message ?? error);
    return null;
  }
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
  const weatherSnapshot = await fetchWeatherSnapshot();

  for (const segment of streetSegments) {
    const allowedDirections = segment?.metadata?.allowedDirections ?? ["forward", "reverse"];
    if (!Array.isArray(allowedDirections) || allowedDirections.length === 0) {
      if (logErrors) {
        console.warn(`No allowed directions configured for segment ${segment.id}. Skipping.`);
      }
      continue;
    }

    for (const direction of allowedDirections) {
      try {
        const sample = await fetchTravelTime({ segment, direction });
        samples.push({
          ...sample,
          weather: weatherSnapshot,
          allowedDirections: [...allowedDirections]
        });
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
