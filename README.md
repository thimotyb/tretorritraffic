# Tre Torri Traffic Poller

Collect travel-time snapshots for the Tre Torri block in Cernusco sul Naviglio using the Google Maps Routes API. The project provides a runnable poller, documentation for scheduling repeated collections, and pointers for extending the dataset toward a full traffic-visualization stack.

## Why this project exists

- Build a ground-truth archive of Google Maps travel times for a small urban grid where official historical traffic data is unavailable or prohibitively expensive.
- Support downstream tools (dashboards, simulations, routing experiments) with a simple JSONL dataset keyed by street segment, direction, and timestamp.
- Offer a foundation that can later power a React map, analytical notebooks, or traffic-scenario simulations.

## Repository structure

```
├── data/                     # JSONL output (created after first poll)
├── src/
│   ├── poller.js             # Main polling script calling Google Routes
│   └── segments.js           # Street endpoint definitions for Tre Torri block
├── .env.example              # Environment variable template
├── AGENTS.md                 # Operational playbook for human/automation agents
├── README.md
├── package.json
└── package-lock.json
```

## Prerequisites

- Node.js 18 or newer (ships with built-in `fetch` used by the poller)
- A Google Cloud project with **Routes API** enabled
- A Maps API key with traffic data access and billing enabled

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure credentials:
   ```bash
   cp .env.example .env
   echo "GOOGLE_MAPS_API_KEY=your-key" >> .env
   ```
3. (Optional) Customize street segments in `src/segments.js` if you wish to add/remove streets or refine coordinates.
4. (Optional) Start the lightweight HTTP control server if you want to trigger manual polls from the web UI:
   ```bash
   npm run poll:server
   ```
   The service listens on `http://localhost:4000/poll` by default (configurable via `POLL_SERVER_PORT`).

## Running the poller

Trigger a one-off collection:
```bash
npm run poll
```

The script performs the following for each street in `src/segments.js`:
- Requests a route in both directions (`forward`, `reverse`) using the Google Routes API.
- Captures distance, live travel time, static (free-flow) time, and delay.
- Appends each observation to `data/traffic_samples.jsonl` as a JSON line.

The default configuration monitors the core Tre Torri block plus nearby approaches along Via Don Luigi Sturzo, Via Sant'Ambrogio, Via Don Lorenzo Milani, Via Pontida, Via Filippo Corridoni, Via Don Primo Mazzolari, Via Leonardo da Vinci (full length), Via Milano, Via Melghera, and Via Padre Kolbe.

Console output provides quick feedback on durations and delays or reports API errors if encountered.

### Scheduling repeated polls

To build a historical dataset, wire `npm run poll` to a scheduler of your choice:

- **Local cron example** (every hour at minute 5):
  ```cron
  5 * * * * cd /home/you/tretorritraffic && /usr/bin/npm run poll >> cron.log 2>&1
  ```
- **Cloud Scheduler / GitHub Actions**: create a workflow or scheduled job that checks out the repository, installs dependencies, and runs `npm run poll`. Ensure secrets contain the API key and that output artifacts (JSONL files) are persisted (e.g., upload to storage or commit to a data repo).

Keep at least a few minutes between invocations to respect Google’s QPS and quota limits. If you need higher temporal granularity, consider staggered schedules or multiple API keys under the same billing account.

## Output format

Each entry in `data/traffic_samples.jsonl` matches:

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

Field notes:
- `requestedAt`: ISO-8601 timestamp captured at request time.
- `durationSeconds`: travel time under current traffic.
- `staticDurationSeconds`: free-flow baseline returned by Google.
- `delaySeconds`: difference between live and static durations (null if not provided).
- `speedReadingIntervals`: optional speed buckets when Google exposes granular slowdowns.

Downstream processing can load the file with tools like `jq`, Python/pandas (`read_json(..., lines=True)`), or stream it into a database.

## Extending the project

- **Add more streets**: append additional segments to `src/segments.js`. The poller automatically picks them up and queries both directions.
- **Persist to a database**: replace the JSONL append step with inserts into Postgres, BigQuery, etc., to enable richer analytics.
- **Integrate with a frontend**: expose a REST API that serves aggregated metrics and feed those into a React map visualization.
- **Simulations**: use the captured static vs. live durations to calibrate simple delay models and evaluate one-way scenarios (see `AGENTS.md` for suggested workflows).

## Frontend visualisation

A React application lives under `frontend/` to explore the collected dataset on top of an interactive OpenStreetMap basemap.

### Run the UI locally

```bash
cd frontend
npm install
cp .env.example .env  # Optional: customise VITE_POLL_ENDPOINT if needed
npm run dev
```

Vite serves the app on <http://localhost:5173/> by default. The UI reads the JSON Lines file from `../data/traffic_samples.jsonl`, colour-codes each street segment by travel-time ratio, and shows per-direction metrics for the chosen snapshot.

- Use the drop-down or the timeline slider (grouped into rolling 5-minute windows) to switch between polling snapshots. All street traces remain on the map, with the currently selected window highlighted according to congestion severity.
- Adjust the time-range selector to zoom the slider to the last 24/48 hours, last 7 days, the full dataset, or a custom calendar range.
- If the poll control server is running, the **Run poll now** button will trigger a fresh Google Routes collection (`POST /poll`) and refresh the dataset in-place. Configure the endpoint with `frontend/.env` (`VITE_POLL_ENDPOINT`).

### Build for production

```bash
cd frontend
npm run build
```

The build output is generated in `frontend/dist/`. The Vite configuration copies `data/traffic_samples.jsonl` into the build folder so the static bundle can render without additional wiring. You can host the resulting files behind any static web server.

## Limitations & considerations

- Google does not expose historical traffic; this collector only records data from the moment you start running it.
- API usage incurs billing. Monitor quota and costs, especially when scheduling frequent polls.
- Coordinates are derived from OpenStreetMap and represent street endpoints; adjust them if you require precise routing waypoints.
- The poller currently uses a blocking loop per request; for larger street sets you may want to parallelize with concurrency controls.

## License

This repository is currently unlicensed. Add a license file if you intend to distribute or open-source the collected data/code.
