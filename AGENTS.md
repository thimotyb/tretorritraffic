# Agent Playbook

Guidelines for humans or automation agents collaborating on the Tre Torri traffic project. Adapt the roles to your tooling (GitHub Actions, Airflow, cron jobs, manual analysts, etc.).

## Common conventions
- All agents must respect the Google Maps Platform Terms of Service and quotas.
- Store secrets (API keys, credentials) in secure vaults or CI secrets; never commit them.
- Prefer JSON Lines (`data/traffic_samples.jsonl`) as the shared data exchange format.
- Communicate via pull requests or issues before changing poll schedules or data schemas.
- Autogrill reference icon now lives at 45.5188, 9.3210; simulation overlays (e.g., “Simulazione Bypass Per Leonardo Da Vinci”) and new school segments have been added—ensure future map enhancements account for these custom layers.

## Agent roles

### 1. Data Poller Agent
Responsible for running `npm run poll` to capture travel-time snapshots.

**Inputs**
- `GOOGLE_MAPS_API_KEY` (env var)
- `src/segments.js` (street definitions)
- Open-Meteo public endpoint (no key required; ensure outbound HTTPS is permitted)

**Outputs**
- Appended entries in `data/traffic_samples.jsonl`
- Logs (stdout, optional file for cron jobs)

**Runbook**
1. Ensure dependencies are installed (`npm ci`).
2. Load API key from the environment.
3. Execute `npm run poll`.
4. Verify the command reports successful durations for each segment; investigate any `Google Routes API error` messages.
5. Confirm the log notes a weather snapshot; transient weather failures fall back to null but should be monitored.
6. Archive the updated JSONL (e.g., upload, commit to data repo, or sync to cloud storage).
7. For unattended runs, use `./scripts/start_polling.sh [intervalSeconds]` (defaults to 900) and stop with `./scripts/stop_polling.sh`; these wrappers execute `npm run poll` followed by `npm run enrich` each cycle and log to `data/poller.log`.

**Failure recovery**
- Retry after a short delay if errors reference transient HTTP issues.
- For quota or permission errors, escalate to project owners to review API key and billing status.

### 2. Scheduler Agent
Automates periodic polling (cron, GitHub Actions, Cloud Scheduler).

**Inputs**
- Poll command (`npm run poll`)
- Schedule definition (cron expression or cloud schedule)

**Outputs**
- Triggered poller runs at agreed cadence
- Monitoring alerts on failures or missing executions

**Runbook**
1. Configure environment with API secrets.
2. Install dependencies on each run (`npm ci`).
3. Execute poll command and collect logs.
4. Upload artifacts (JSONL file, logs) to persistent storage.
5. Emit metrics/alerts (e.g., via email, Slack, monitoring dashboards).

**Failure recovery**
- If a run fails, initiate an immediate retry.
- If multiple consecutive failures occur, notify maintainers and pause the schedule to avoid quota waste.

### 3. Data Quality Agent
Validates and prepares the collected dataset for analysis.

**Inputs**
- `data/traffic_samples.jsonl`

**Outputs**
- Quality reports (missing fields, outliers, API anomalies)
- Cleaned/aggregated data tables (optional)

**Runbook**
1. Load new JSONL entries (pandas, BigQuery, etc.).
2. Check for null durations, unreasonable values, or sudden shifts.
3. Validate `weather` fields (code, condition, temperature) and flag missing snapshots when the poll succeeded.
4. Flag suspect records and, if needed, remove or tag them for downstream consumers.
5. Produce summary statistics per segment/day for dashboards, confirming enrichment fields (`lengthMeters`, `capacityVph`, `derivedFlowVph`, `volumeCapacityRatio`, `flowConfidence`) align with expectations.

**Failure recovery**
- If the dataset is empty for expected intervals, notify Scheduler and Poller agents.
- Document issues and recommendations in project tracker.

### 4. Frontend Visualization Agent
Builds and maintains the React-based map UI (future milestone).

**Inputs**
- Aggregated traffic dataset or API endpoint
- Map styling guidelines
- Weather metadata bundled with each sample (condition, temperature, observation time)

**Outputs**
- React components showing historical/simulated traffic on the Tre Torri block
- Deployment package (static build or container)

**Runbook**
1. Consume backend API or static JSON snapshots.
2. Render polylines for each street with congestion color coding.
3. Provide date/time selectors, weather badges, and chart interactions (modal icon opens travel-time and flow time-series using current range).
4. Keep map ↔ panel interactions aligned: clicking a segment should scroll to the matching card, and hovering a direction should show the map arrow overlay.
5. Coordinate with Simulation Agent for scenario result formats.

**Failure recovery**
- If data endpoints change, update fetch logic and notify backend maintainers.

### 5. Simulation Agent
Designs and executes traffic scenarios (e.g., one-way conversions).

**Inputs**
- Baseline travel-time dataset
- Street network graph (can be derived from `src/segments.js` + OSM)
- Scenario definitions (e.g., “Via Pontida one-way eastbound”)

**Outputs**
- Simulated travel-time deltas per segment/direction
- Documentation of algorithms, assumptions, parameter choices

**Runbook**
1. Build or update a network model (nodes/edges, capacities, free-flow speeds).
2. Calibrate delay functions using observed `durationSeconds` vs `staticDurationSeconds`.
3. Apply scenario modifications (change directionality, adjust capacities).
4. Run assignment/propagation algorithm and compute new travel times.
5. Store results in a format consumable by the Frontend Visualization Agent (GeoJSON or JSON).

**Failure recovery**
- If calibration diverges, revisit dataset quality or select simpler heuristics.
- Log limitations and confidence intervals for each scenario.

### 6. Project Steward Agent
Ensures governance, documentation, and coordination.

**Responsibilities**
- Review pull requests, maintain coding/documentation standards.
- Track API quotas, billing, and compliance obligations.
- Organize roadmap tasks and triage bugs/questions.

---

Update this playbook as new automation or collaborators join the project. Keep role descriptions concise and actionable so agents can execute tasks with minimal onboarding time.
