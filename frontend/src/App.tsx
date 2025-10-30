import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet'
import type { LatLngExpression } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'

interface Coordinate {
  latitude: number
  longitude: number
}

interface TrafficSample {
  segmentId: string
  segmentName: string
  direction: 'forward' | 'reverse'
  requestedAt: string
  origin: Coordinate
  destination: Coordinate
  distanceMeters: number | null
  durationSeconds: number | null
  staticDurationSeconds: number | null
  delaySeconds: number | null
  speedReadingIntervals: unknown
  routeLabels: string[] | null
}

type LoadedState = 'idle' | 'loading' | 'ready' | 'error'

interface SegmentTrace {
  key: string
  positions: LatLngExpression[]
  segmentName: string
  direction: 'forward' | 'reverse'
}

interface SnapshotGroup {
  key: string
  samples: TrafficSample[]
}

const MAP_CENTER: LatLngExpression = [45.5189, 9.3247]
const MAP_ZOOM = 16
const POLL_ENDPOINT = import.meta.env.VITE_POLL_ENDPOINT || 'http://localhost:4000/poll'
const SNAPSHOT_WINDOW_MINUTES = 5

type TimeWindowPreset =
  | 'LAST_24_HOURS'
  | 'LAST_48_HOURS'
  | 'LAST_7_DAYS'
  | 'FULL_RANGE'
  | 'CUSTOM'

const TIME_WINDOW_OPTIONS: { value: TimeWindowPreset; label: string }[] = [
  { value: 'LAST_24_HOURS', label: 'Last 24 hours' },
  { value: 'LAST_48_HOURS', label: 'Last 48 hours' },
  { value: 'LAST_7_DAYS', label: 'Last 7 days' },
  { value: 'FULL_RANGE', label: 'Full dataset' },
  { value: 'CUSTOM', label: 'Custom range…' },
]

function parseJsonl(text: string): TrafficSample[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrafficSample)
}

function formatSnapshotRange(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const end = new Date(date.getTime() + SNAPSHOT_WINDOW_MINUTES * 60 * 1000)
  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  const startTime = date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  const endTime = end.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${dateLabel} ${startTime} – ${endTime}`
}

function formatDatetimeLocalInput(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function formatCoordinate({ latitude, longitude }: Coordinate): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`
}

function getRatio(sample: TrafficSample): number | null {
  if (sample.durationSeconds == null || sample.staticDurationSeconds == null) {
    return null
  }
  if (sample.staticDurationSeconds === 0) {
    return null
  }
  return sample.durationSeconds / sample.staticDurationSeconds
}

function getColorForRatio(ratio: number | null): string {
  if (ratio == null) return '#95a5a6'
  if (ratio <= 1.05) return '#2ecc71'
  if (ratio <= 1.25) return '#f1c40f'
  if (ratio <= 1.5) return '#e67e22'
  return '#e74c3c'
}

function getWeightForRatio(ratio: number | null): number {
  if (ratio == null) return 4
  return Math.min(8, Math.max(3, ratio * 4))
}

interface SegmentCardProps {
  sample: TrafficSample
}

function SegmentCard({ sample }: SegmentCardProps) {
  const ratio = getRatio(sample)
  const deltaSeconds =
    sample.durationSeconds != null && sample.staticDurationSeconds != null
      ? sample.durationSeconds - sample.staticDurationSeconds
      : null

  return (
    <article className="segment-card">
      <header>
        <div>
          <h3>{sample.segmentName}</h3>
          <p className="direction-path">
            {formatCoordinate(sample.origin)} <span className="direction-arrow">→</span>{' '}
            {formatCoordinate(sample.destination)}
          </p>
        </div>
        <span className="direction">{sample.direction}</span>
      </header>
      <dl>
        <div>
          <dt>
            Live time
            <span
              className="info-icon"
              tabIndex={0}
              aria-label="Live Time is the current travel time predicted by Google Routes"
              data-tooltip="Live Time is the current travel time predicted by Google Routes"
            >
              i
            </span>
          </dt>
          <dd>{sample.durationSeconds != null ? `${sample.durationSeconds}s` : 'n/a'}</dd>
        </div>
        <div>
          <dt>
            Free-flow
            <span
              className="info-icon"
              tabIndex={0}
              aria-label="Free Flow is the estimated duration with no congestion"
              data-tooltip="Free Flow is the estimated duration with no congestion"
            >
              i
            </span>
          </dt>
          <dd>
            {sample.staticDurationSeconds != null
              ? `${sample.staticDurationSeconds}s`
              : 'n/a'}
          </dd>
        </div>
        <div>
          <dt>
            Delta
            <span
              className="info-icon"
              tabIndex={0}
              aria-label="Delta equals Live Time minus Free Flow"
              data-tooltip="Delta equals Live Time minus Free Flow"
            >
              i
            </span>
          </dt>
          <dd>
            {deltaSeconds != null ? `${deltaSeconds >= 0 ? '+' : ''}${deltaSeconds}s` : 'n/a'}
          </dd>
        </div>
        <div>
          <dt>
            Ratio
            <span
              className="info-icon"
              tabIndex={0}
              aria-label="Ratio divides Live Time by Free Flow to show congestion"
              data-tooltip="Ratio divides Live Time by Free Flow to show congestion"
            >
              i
            </span>
          </dt>
          <dd>{ratio != null ? ratio.toFixed(2) : 'n/a'}</dd>
        </div>
      </dl>
    </article>
  )
}

function normaliseTimestampToWindow(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const minutes = date.getMinutes()
  const bucketMinutes = Math.floor(minutes / SNAPSHOT_WINDOW_MINUTES) * SNAPSHOT_WINDOW_MINUTES
  date.setMinutes(bucketMinutes, 0, 0)
  return date.toISOString()
}

export default function App() {
  const [samples, setSamples] = useState<TrafficSample[]>([])
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null)
  const [loadState, setLoadState] = useState<LoadedState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isPolling, setIsPolling] = useState(false)
  const [pollStatus, setPollStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(
    null,
  )
  const [timePreset, setTimePreset] = useState<TimeWindowPreset>('LAST_48_HOURS')
  const [customStart, setCustomStart] = useState<string>('')
  const [customEnd, setCustomEnd] = useState<string>('')

  const loadSamples = useCallback(async () => {
    setLoadState('loading')
    setError(null)
    try {
      const response = await fetch('/traffic_samples.jsonl', {
        cache: 'no-store',
        headers: {
          Pragma: 'no-cache',
          'Cache-Control': 'no-store',
        },
      })
      if (!response.ok) {
        throw new Error(`Failed to fetch dataset: ${response.status} ${response.statusText}`)
      }
      const text = await response.text()
      const parsed = parseJsonl(text)
      setSamples(parsed)
      setLoadState('ready')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      setError(message)
      setLoadState('error')
    }
  }, [])

  useEffect(() => {
    loadSamples()
  }, [loadSamples])

  const snapshotGroupsAsc: SnapshotGroup[] = useMemo(() => {
    const bucket = new Map<string, TrafficSample[]>()
    for (const sample of samples) {
      const key = normaliseTimestampToWindow(sample.requestedAt)
      const collection = bucket.get(key)
      if (collection) {
        collection.push(sample)
      } else {
        bucket.set(key, [sample])
      }
    }
    const entries = Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))
    return entries.map(([key, groupedSamples]) => ({ key, samples: groupedSamples }))
  }, [samples])

  const earliestGroupKey = snapshotGroupsAsc.length > 0 ? snapshotGroupsAsc[0].key : null
  const latestGroupKey = snapshotGroupsAsc.length > 0 ? snapshotGroupsAsc[snapshotGroupsAsc.length - 1].key : null

  const activeRange = useMemo(() => {
    if (snapshotGroupsAsc.length === 0) {
      return { start: null as Date | null, end: null as Date | null }
    }

    const earliest = earliestGroupKey ? new Date(earliestGroupKey) : null
    const latest = latestGroupKey ? new Date(latestGroupKey) : null
    let start: Date | null = null
    let end: Date | null = null

    switch (timePreset) {
      case 'LAST_24_HOURS':
        if (latest) {
          start = new Date(latest.getTime() - 24 * 60 * 60 * 1000)
          end = latest
        }
        break
      case 'LAST_48_HOURS':
        if (latest) {
          start = new Date(latest.getTime() - 48 * 60 * 60 * 1000)
          end = latest
        }
        break
      case 'LAST_7_DAYS':
        if (latest) {
          start = new Date(latest.getTime() - 7 * 24 * 60 * 60 * 1000)
          end = latest
        }
        break
      case 'FULL_RANGE':
        start = earliest
        end = latest
        break
      case 'CUSTOM': {
        const startCandidate = customStart ? new Date(customStart) : null
        const endCandidate = customEnd ? new Date(customEnd) : null
        start = startCandidate && !Number.isNaN(startCandidate.getTime()) ? startCandidate : null
        end = endCandidate && !Number.isNaN(endCandidate.getTime()) ? endCandidate : null
        break
      }
      default:
        break
    }

    if (!start && earliest) {
      start = earliest
    }
    if (!end && latest) {
      end = latest
    }

    if (start && earliest && start < earliest) {
      start = earliest
    }
    if (end && latest && end > latest) {
      end = latest
    }
    if (start && end && end < start) {
      end = new Date(start.getTime())
    }

    return { start, end }
  }, [snapshotGroupsAsc, earliestGroupKey, latestGroupKey, timePreset, customStart, customEnd])

  const rangeStartMs = activeRange.start ? activeRange.start.getTime() : null
  const rangeEndMs = activeRange.end ? activeRange.end.getTime() : null

  const visibleSnapshotGroupsAsc = useMemo(() => {
    if (snapshotGroupsAsc.length === 0) return []
    return snapshotGroupsAsc.filter(({ key }) => {
      const date = new Date(key)
      if (Number.isNaN(date.getTime())) return false
      const ms = date.getTime()
      if (rangeStartMs != null && ms < rangeStartMs) return false
      if (rangeEndMs != null && ms > rangeEndMs) return false
      return true
    })
  }, [snapshotGroupsAsc, rangeStartMs, rangeEndMs])

  const visibleSnapshotGroupsDesc = useMemo(
    () => [...visibleSnapshotGroupsAsc].reverse(),
    [visibleSnapshotGroupsAsc],
  )

  const earliestInputValue = useMemo(
    () => formatDatetimeLocalInput(earliestGroupKey ? new Date(earliestGroupKey) : null),
    [earliestGroupKey],
  )

  const latestInputValue = useMemo(
    () => formatDatetimeLocalInput(latestGroupKey ? new Date(latestGroupKey) : null),
    [latestGroupKey],
  )

  useEffect(() => {
    if (timePreset !== 'CUSTOM') {
      return
    }
    if (!customStart && earliestGroupKey) {
      setCustomStart(formatDatetimeLocalInput(new Date(earliestGroupKey)))
    }
    if (!customEnd && latestGroupKey) {
      setCustomEnd(formatDatetimeLocalInput(new Date(latestGroupKey)))
    }
  }, [timePreset, customStart, customEnd, earliestGroupKey, latestGroupKey])

  useEffect(() => {
    if (timePreset !== 'CUSTOM') return
    if (!customStart || !customEnd) return
    const startDate = new Date(customStart)
    const endDate = new Date(customEnd)
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return
    if (endDate < startDate) {
      setCustomEnd(customStart)
    }
  }, [timePreset, customStart, customEnd])

  useEffect(() => {
    if (visibleSnapshotGroupsDesc.length === 0) {
      if (snapshotKey !== null) {
        setSnapshotKey(null)
      }
      return
    }

    const exists = snapshotKey
      ? visibleSnapshotGroupsAsc.some((group) => group.key === snapshotKey)
      : false

    if (!exists) {
      setSnapshotKey(visibleSnapshotGroupsDesc[0].key)
    }
  }, [snapshotKey, visibleSnapshotGroupsAsc, visibleSnapshotGroupsDesc])

  const sliderValue = useMemo(() => {
    if (visibleSnapshotGroupsAsc.length === 0) return 0
    if (!snapshotKey) return visibleSnapshotGroupsAsc.length - 1
    const index = visibleSnapshotGroupsAsc.findIndex((group) => group.key === snapshotKey)
    return index >= 0 ? index : visibleSnapshotGroupsAsc.length - 1
  }, [snapshotKey, visibleSnapshotGroupsAsc])

  const samplesForSnapshot = useMemo(() => {
    if (!snapshotKey) return []
    const group = snapshotGroupsAsc.find((entry) => entry.key === snapshotKey)
    return group?.samples ?? []
  }, [snapshotGroupsAsc, snapshotKey])

  const latestSnapshotKey = visibleSnapshotGroupsDesc[0]?.key ?? null
  const sliderMax = Math.max(visibleSnapshotGroupsAsc.length - 1, 0)

  const allTraces: SegmentTrace[] = useMemo(() => {
    const registry = new Map<string, SegmentTrace>()
    for (const sample of samples) {
      const key = `${sample.segmentId}-${sample.direction}`
      if (registry.has(key)) continue
      registry.set(key, {
        key,
        positions: [
          [sample.origin.latitude, sample.origin.longitude],
          [sample.destination.latitude, sample.destination.longitude],
        ],
        segmentName: sample.segmentName,
        direction: sample.direction,
      })
    }
    return Array.from(registry.values())
  }, [samples])

  const handleTimePresetChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value as TimeWindowPreset
    setTimePreset(value)
    if (value === 'CUSTOM') {
      if (!customStart && earliestGroupKey) {
        setCustomStart(formatDatetimeLocalInput(new Date(earliestGroupKey)))
      }
      if (!customEnd && latestGroupKey) {
        setCustomEnd(formatDatetimeLocalInput(new Date(latestGroupKey)))
      }
    }
  }

  const handleCustomStartChange = (event: ChangeEvent<HTMLInputElement>) => {
    setCustomStart(event.target.value)
  }

  const handleCustomEndChange = (event: ChangeEvent<HTMLInputElement>) => {
    setCustomEnd(event.target.value)
  }

  const handleSnapshotChange = (value: string) => {
    if (!value) return
    setSnapshotKey(value)
  }

  const handleSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const index = Number(event.target.value)
    const nextGroup = visibleSnapshotGroupsAsc[index]
    if (nextGroup) {
      setSnapshotKey(nextGroup.key)
    }
  }

  const handleRunPoll = useCallback(async () => {
    if (isPolling) return
    setIsPolling(true)
    setPollStatus(null)
    try {
      const response = await fetch(POLL_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        mode: 'cors',
      })
      if (!response.ok) {
        const message = await response.text()
        throw new Error(message || `Poll request failed with ${response.status}`)
      }
      const result = await response.json().catch(() => ({ count: undefined }))
      const count = typeof result.count === 'number' ? result.count : null
      setPollStatus({
        type: 'success',
        message: count != null ? `Poll complete: ${count} samples appended.` : 'Poll complete.',
      })
      await loadSamples()
    } catch (err) {
      let message = err instanceof Error ? err.message : 'Unknown error triggering poll'
      if (err instanceof TypeError) {
        message =
          'Unable to reach the poll endpoint. Ensure the poll control server is running (npm run poll:server).' 
      }
      setPollStatus({ type: 'error', message })
    } finally {
      setIsPolling(false)
    }
  }, [isPolling, loadSamples])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <h1>Tre Torri Traffic Monitor</h1>
          <p>Visualise Google Routes travel times collected by the poller.</p>
        </div>
        <div className="timestamp-picker">
          <div className="time-slider-row">
            <div className="control-group time-range-group">
              <label htmlFor="time-range">Time range</label>
              <select
                id="time-range"
                value={timePreset}
                onChange={handleTimePresetChange}
                disabled={snapshotGroupsAsc.length === 0 || loadState === 'loading'}
              >
                {TIME_WINDOW_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="control-group slider-control">
              <label htmlFor="time-slider">Time (HH:MM)</label>
              <input
                id="time-slider"
                type="range"
                min={0}
                max={sliderMax}
                step={1}
                value={sliderValue}
                onChange={handleSliderChange}
                disabled={visibleSnapshotGroupsAsc.length === 0 || loadState === 'loading'}
              />
              <div className="slider-ticks">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
          {timePreset === 'CUSTOM' && (
            <div className="custom-range">
              <div className="custom-range-field">
                <label htmlFor="custom-range-start">Start</label>
                <input
                  id="custom-range-start"
                  type="datetime-local"
                  value={customStart}
                  onChange={handleCustomStartChange}
                  min={earliestInputValue || undefined}
                  max={latestInputValue || undefined}
                  disabled={snapshotGroupsAsc.length === 0}
                />
              </div>
              <div className="custom-range-field">
                <label htmlFor="custom-range-end">End</label>
                <input
                  id="custom-range-end"
                  type="datetime-local"
                  value={customEnd}
                  onChange={handleCustomEndChange}
                  min={customStart || earliestInputValue || undefined}
                  max={latestInputValue || undefined}
                  disabled={snapshotGroupsAsc.length === 0}
                />
              </div>
            </div>
          )}
          <div className="control-group">
            <label htmlFor="timestamp-select">Snapshot</label>
            <select
              id="timestamp-select"
              value={snapshotKey ?? ''}
              onChange={(event) => handleSnapshotChange(event.target.value)}
              disabled={visibleSnapshotGroupsDesc.length === 0 || loadState === 'loading'}
            >
              {visibleSnapshotGroupsDesc.map((group) => (
                <option key={group.key} value={group.key}>
                  {formatSnapshotRange(group.key)}
                </option>
              ))}
            </select>
          </div>
          <div className="control-group poll-actions">
            <button
              type="button"
              className="poll-button"
              onClick={handleRunPoll}
              disabled={isPolling || loadState === 'loading'}
            >
              {isPolling ? 'Running poll…' : 'Run poll now'}
            </button>
            {pollStatus && (
              <p className={`poll-status ${pollStatus.type === 'error' ? 'error' : 'success'}`}>
                {pollStatus.message}
              </p>
            )}
          </div>
        </div>
      </header>

      {loadState === 'loading' && <p className="status">Loading traffic samples…</p>}
      {loadState === 'error' && <p className="status error">{error}</p>}

      <main className="content">
        <section className="map-section">
          <div className="map-wrapper">
            <MapContainer center={MAP_CENTER} zoom={MAP_ZOOM} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {allTraces.map((trace) => (
                <Polyline
                  key={`base-${trace.key}`}
                  positions={trace.positions}
                  pathOptions={{ color: '#cbd5f5', weight: 3, opacity: 0.45 }}
                  interactive={false}
                />
              ))}
              {samplesForSnapshot.map((sample) => {
                const ratio = getRatio(sample)
                const color = getColorForRatio(ratio)
                const weight = getWeightForRatio(ratio)
                const positions: LatLngExpression[] = [
                  [sample.origin.latitude, sample.origin.longitude],
                  [sample.destination.latitude, sample.destination.longitude],
                ]

                return (
                  <Polyline
                    key={`${sample.segmentId}-${sample.direction}`}
                    positions={positions}
                    pathOptions={{ color, weight }}
                  >
                    <Tooltip sticky>
                      <strong>{sample.segmentName}</strong>
                      <br />
                      Direction: {sample.direction}
                      <br />
                      {formatCoordinate(sample.origin)} → {formatCoordinate(sample.destination)}
                      <br />
                      Live: {sample.durationSeconds != null ? `${sample.durationSeconds}s` : 'n/a'}
                      <br />
                      Free-flow:{' '}
                      {sample.staticDurationSeconds != null ? `${sample.staticDurationSeconds}s` : 'n/a'}
                      <br />
                      Ratio: {getRatio(sample)?.toFixed(2) ?? 'n/a'}
                    </Tooltip>
                  </Polyline>
                )
              })}
            </MapContainer>
          </div>
          <aside className="legend">
            <h2>Legend</h2>
            <ul>
              <li>
                <span className="swatch" style={{ background: '#2ecc71' }} />
                &le; 1.05 × baseline
              </li>
              <li>
                <span className="swatch" style={{ background: '#f1c40f' }} />
                1.05 – 1.25 ×
              </li>
              <li>
                <span className="swatch" style={{ background: '#e67e22' }} />
                1.25 – 1.5 ×
              </li>
              <li>
                <span className="swatch" style={{ background: '#e74c3c' }} />
                &gt; 1.5 ×
              </li>
              <li>
                <span className="swatch" style={{ background: '#95a5a6' }} />
                Baseline unavailable
              </li>
            </ul>
          </aside>
        </section>

        <section className="details-section">
          <header>
            <h2>Segment metrics</h2>
            <p>{snapshotKey ? formatSnapshotRange(snapshotKey) : 'No snapshot selected'}</p>
          </header>
          <div className="segment-list">
            {samplesForSnapshot.length === 0 && (
              <p className="empty">No samples available for the selected snapshot.</p>
            )}
            {samplesForSnapshot
              .slice()
              .sort((a, b) => a.segmentName.localeCompare(b.segmentName))
              .map((sample) => (
                <SegmentCard key={`${sample.segmentId}-${sample.direction}`} sample={sample} />
              ))}
          </div>
        </section>
      </main>

      <footer className="app-footer">
        <p>
          Showing {samplesForSnapshot.length} of {samples.length} samples. Latest snapshot:{' '}
          {formatSnapshotRange(latestSnapshotKey)}.
        </p>
      </footer>
    </div>
  )
}
