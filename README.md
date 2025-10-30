# Tre Torri Traffic Poller

This repository bootstraps an hourly/adhoc poller that records travel-time snapshots for the Tre Torri block in Cernusco sul Naviglio using the Google Maps Routes API. Each run queries the endpoints of the streets in both directions and appends the response to a JSON Lines file for later analysis.

## Prerequisites

- Node.js 18+
- A Google Cloud project with the **Routes API** enabled and a Maps API key that has access to real-time traffic data.

## Setup

1. Install dependencies (only `dotenv` is required, Node 18 ships a native `fetch` implementation):
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and add your API key:
   ```bash
   cp .env.example .env
   echo "GOOGLE_MAPS_API_KEY=your-key" >> .env
   ```

## Running the poller

Execute the poller to capture a snapshot for each street and direction:

```bash
npm run poll
```

When the command completes, a JSON Lines file will be updated at `data/traffic_samples.jsonl`. Each line contains the segment identifier, direction, origin/destination coordinates, travel time, baseline (static) time, delay, and speed-interval breakdown from Google Maps.

Sample entry:

```json
{
  "segmentId": "via-pontida",
  "segmentName": "Via Pontida",
  "direction": "forward",
  "requestedAt": "2024-03-12T10:22:00.123Z",
  "origin": { "latitude": 45.5178105, "longitude": 9.3229557 },
  "destination": { "latitude": 45.5179762, "longitude": 9.3262213 },
  "distanceMeters": 275,
  "durationSeconds": 58,
  "staticDurationSeconds": 45,
  "delaySeconds": 13,
  "speedReadingIntervals": [ ... ],
  "routeLabels": ["DEFAULT_ROUTE"]
}
```

### Scheduling collection

To build a historical dataset, wire the `npm run poll` command into your scheduling system (cron, GitHub Actions, Cloud Scheduler, etc.). Keeping a minimum gap of a few minutes between polls helps you stay under quota and capture meaningful variability.

## Notes

- The street endpoint coordinates are derived from OpenStreetMap and may require refinement if you need higher geometric fidelity.
- The poller does not deduplicate samples; post-processing scripts can filter or aggregate by timestamp as needed.
- Consider persisting data in a database once volume grows; JSON Lines is convenient for the early exploratory phase.
