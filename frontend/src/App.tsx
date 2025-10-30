import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { MapContainer, Marker, Polyline, TileLayer, Tooltip } from 'react-leaflet'
import L, { type LatLngExpression } from 'leaflet'
import {
  CartesianGrid,
  Legend as RechartsLegend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'
import 'leaflet/dist/leaflet.css'
import './App.css'
import heroImage from './assets/tre-torri-bg.jpeg'

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
  weather?: WeatherSnapshot | null
  lengthMeters?: number | null
  freeFlowSpeedKph?: number | null
  capacityVph?: number | null
  volumeCapacityRatio?: number | null
  derivedFlowVph?: number | null
  flowConfidence?: string | null
  flowEstimationModel?: {
    alpha: number
    beta: number
    source?: string
    notes?: string
  } | null
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

interface WeatherSnapshot {
  weatherCode: number | null
  condition: string | null
  temperatureC: number | null
  observedAt: string | null
  provider?: string | null
}

const MAP_CENTER: LatLngExpression = [45.5189, 9.3247]
const MAP_ZOOM = 16
const POLL_ENDPOINT = import.meta.env.VITE_POLL_ENDPOINT || 'http://localhost:4000/poll'
const SNAPSHOT_WINDOW_MINUTES = 5
const BPR_ALPHA = 0.15
const BPR_BETA = 4
const DATA_URL = `${import.meta.env.BASE_URL}traffic_samples.jsonl`

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

function computeMidpoint(a: Coordinate, b: Coordinate): Coordinate {
  return {
    latitude: (a.latitude + b.latitude) / 2,
    longitude: (a.longitude + b.longitude) / 2,
  }
}

function computeBearingDegrees(a: Coordinate, b: Coordinate): number {
  const rad = Math.PI / 180
  const lat1 = a.latitude * rad
  const lat2 = b.latitude * rad
  const dLon = (b.longitude - a.longitude) * rad

  const y = Math.sin(dLon) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  const bearing = Math.atan2(y, x)
  return ((bearing * 180) / Math.PI + 360) % 360
}

interface SegmentGroup {
  segmentId: string
  segmentName: string
  directions: TrafficSample[]
}

interface SegmentCardProps {
  group: SegmentGroup
  activeKey: string | null
  onHover: (key: string | null) => void
  onRequestChart: (segmentId: string) => void
  cardRef?: (node: HTMLDivElement | null) => void
}

interface ChartPoint {
  timestamp: number
  label: string
  forwardDuration: number | null
  reverseDuration: number | null
  forwardFlow: number | null
  reverseFlow: number | null
}

function SegmentCard({ group, activeKey, onHover, onRequestChart, cardRef }: SegmentCardProps) {
  const baseSample = group.directions[0] ?? null
  const isGroupActive = group.directions.some(
    (sample) => `${sample.segmentId}-${sample.direction}` === activeKey,
  )
  const weather = baseSample?.weather ?? null
  const lengthMeters = baseSample?.lengthMeters ?? null
  const capacityVph = baseSample?.capacityVph ?? null
  const freeFlowSpeedKph = baseSample?.freeFlowSpeedKph ?? null

  const weatherObservedLabel = weather?.observedAt
    ? new Date(weather.observedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit'
      })
    : null

  return (
    <article
      className={`segment-card${isGroupActive ? ' is-active' : ''}`}
      ref={cardRef}
      tabIndex={-1}
    >
      <header>
        <div>
          <h3>{group.segmentName}</h3>
        </div>
        <div className="segment-card-actions">
          <button
            type="button"
            className="segment-chart-button"
            onClick={() => onRequestChart(group.segmentId)}
            aria-label={`Show live time chart for ${group.segmentName}`}
            title="Show live time chart"
          >
            📈
          </button>
        </div>
      </header>
      {weather && (
        <div className="segment-weather">
          <span className="segment-weather__icon" role="img" aria-label="Weather">
            🌦️
          </span>
          <div className="segment-weather__details">
            <span className="segment-weather__condition">
              {weather.condition ?? 'Weather unavailable'}
            </span>
            <span className="segment-weather__meta">
              {weather.temperatureC != null ? `${weather.temperatureC.toFixed(1)}°C` : '—'}
              {weatherObservedLabel ? ` · ${weatherObservedLabel}` : ''}
            </span>
          </div>
        </div>
      )}
      {(lengthMeters != null || capacityVph != null || freeFlowSpeedKph != null) && (
        <div className="segment-capacity">
          {lengthMeters != null && <span>Length {Math.round(lengthMeters)} m</span>}
          {freeFlowSpeedKph != null && <span>Free-flow {freeFlowSpeedKph.toFixed(1)} km/h</span>}
          {capacityVph != null && <span>Capacity {Math.round(capacityVph)} veh/h</span>}
        </div>
      )}
      <div className="direction-stats">
        {group.directions
          .slice()
          .sort((a, b) => a.direction.localeCompare(b.direction))
          .map((sample) => {
            const segmentKey = `${sample.segmentId}-${sample.direction}`
            const ratio = getRatio(sample)
            const deltaSeconds =
              sample.durationSeconds != null && sample.staticDurationSeconds != null
                ? sample.durationSeconds - sample.staticDurationSeconds
                : null
            const isActive = activeKey === segmentKey
            const flowVph = sample.derivedFlowVph ?? null
            const volumeCapacityRatio = sample.volumeCapacityRatio ?? null
            const rawFlowConfidence = sample.flowConfidence ?? null
            const normalizedFlowConfidence = rawFlowConfidence
              ? rawFlowConfidence.toLowerCase()
              : 'unknown'

            return (
              <div
                className={`direction-row${isActive ? ' is-active' : ''}`}
                key={segmentKey}
                onMouseEnter={() => onHover(segmentKey)}
                onMouseLeave={() => onHover(null)}
                onFocus={() => onHover(segmentKey)}
                onBlur={() => onHover(null)}
                role="button"
                tabIndex={0}
                aria-label={`${group.segmentName} ${sample.direction}`}
              >
                <div className="direction-label">
                  <span className="direction-chip">{sample.direction}</span>
                  <span className="direction-coords">
                    {formatCoordinate(sample.origin)} <span className="direction-arrow">→</span>{' '}
                    {formatCoordinate(sample.destination)}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>
                      Live
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
                  <div>
                    <dt>
                      Flow
                      <span
                        className="info-icon"
                        tabIndex={0}
                        aria-label="Estimated directional flow from BPR travel-time model"
                        data-tooltip="Estimated directional flow from BPR travel-time model"
                      >
                        i
                      </span>
                    </dt>
                    <dd>{flowVph != null ? `${Math.round(flowVph)} veh/h` : 'n/a'}</dd>
                  </div>
                  <div>
                    <dt>
                      v/c
                      <span
                        className="info-icon"
                        tabIndex={0}
                        aria-label="Volume/capacity ratio computed from estimated flow"
                        data-tooltip="Volume/capacity ratio computed from estimated flow"
                      >
                        i
                      </span>
                    </dt>
                    <dd>
                      {volumeCapacityRatio != null ? volumeCapacityRatio.toFixed(2) : 'n/a'}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      Confidence
                      <span
                        className="info-icon"
                        tabIndex={0}
                        aria-label="Heuristic confidence based on data completeness and congestion"
                        data-tooltip="Heuristic confidence based on data completeness and congestion"
                      >
                        i
                      </span>
                    </dt>
                    <dd
                      className={`flow-confidence flow-confidence--${normalizedFlowConfidence}`}
                    >
                      {rawFlowConfidence ?? 'n/a'}
                    </dd>
                  </div>
                </dl>
              </div>
            )
          })}
      </div>
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
  const [hoveredSegmentKey, setHoveredSegmentKey] = useState<string | null>(null)
  const [chartSegmentId, setChartSegmentId] = useState<string | null>(null)
  const segmentCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [isChartOpen, setIsChartOpen] = useState(false)
  const [isDocOpen, setIsDocOpen] = useState(false)

  const loadSamples = useCallback(async () => {
    setLoadState('loading')
    setError(null)
    try {
      const response = await fetch(DATA_URL, {
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

  const handleSegmentHover = useCallback((key: string | null) => {
    setHoveredSegmentKey(key)
  }, [])

  const handleOpenChart = useCallback((segmentId: string) => {
    setChartSegmentId(segmentId)
    setIsChartOpen(true)
  }, [])

  const handleCloseChart = useCallback(() => {
    setIsChartOpen(false)
    setChartSegmentId(null)
  }, [])

  const handleMapSegmentClick = useCallback(
    (segmentId: string, direction: string) => {
      const key = `${segmentId}-${direction}`
      setHoveredSegmentKey(key)
      const node = segmentCardRefs.current[segmentId]
      if (node) {
        node.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        node.focus({ preventScroll: true })
      }
    },
    [],
  )

  const handleOpenDoc = useCallback(() => {
    setIsDocOpen(true)
  }, [])

  const handleCloseDoc = useCallback(() => {
    setIsDocOpen(false)
  }, [])

  const groupedSegments: SegmentGroup[] = useMemo(() => {
    const groups = new Map<
      string,
      {
        segmentId: string
        segmentName: string
        directions: Map<'forward' | 'reverse', TrafficSample>
      }
    >()
    for (const sample of samplesForSnapshot) {
      const existing = groups.get(sample.segmentId)
      if (!existing) {
        groups.set(sample.segmentId, {
          segmentId: sample.segmentId,
          segmentName: sample.segmentName,
          directions: new Map<'forward' | 'reverse', TrafficSample>(),
        })
      }
      const groupEntry = groups.get(sample.segmentId)!
      const prev = groupEntry.directions.get(sample.direction as 'forward' | 'reverse')
      if (!prev || new Date(sample.requestedAt) > new Date(prev.requestedAt)) {
        groupEntry.directions.set(sample.direction as 'forward' | 'reverse', sample)
      }
    }
    return Array.from(groups.values())
      .map(({ segmentId, segmentName, directions }) => ({
        segmentId,
        segmentName,
        directions: Array.from(directions.values()),
      }))
      .sort((a, b) => a.segmentName.localeCompare(b.segmentName))
  }, [samplesForSnapshot])

  useEffect(() => {
    setHoveredSegmentKey(null)
    setIsChartOpen(false)
    setChartSegmentId(null)
  }, [snapshotKey])

  useEffect(() => {
    if (!isChartOpen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleCloseChart()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isChartOpen, handleCloseChart])

  useEffect(() => {
    if (!isDocOpen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsDocOpen(false)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isDocOpen])

  const chartGroup = useMemo(
    () =>
      chartSegmentId
        ? groupedSegments.find((group) => group.segmentId === chartSegmentId) ?? null
        : null,
    [groupedSegments, chartSegmentId],
  )

  const chartData: ChartPoint[] = useMemo(() => {
    if (!chartSegmentId || !isChartOpen) return []
    const series = new Map<
      number,
      {
        timestamp: number
        forwardDuration: number | null
        reverseDuration: number | null
        forwardFlow: number | null
        reverseFlow: number | null
      }
    >()

    for (const sample of samples) {
      if (sample.segmentId !== chartSegmentId) continue
      const date = new Date(sample.requestedAt)
      const ms = date.getTime()
      if (Number.isNaN(ms)) continue
      if (rangeStartMs != null && ms < rangeStartMs) continue
      if (rangeEndMs != null && ms > rangeEndMs + SNAPSHOT_WINDOW_MINUTES * 60 * 1000) continue

      let entry = series.get(ms)
      if (!entry) {
        entry = {
          timestamp: ms,
          forwardDuration: null,
          reverseDuration: null,
          forwardFlow: null,
          reverseFlow: null,
        }
        series.set(ms, entry)
      }

      if (sample.direction === 'forward') {
        entry.forwardDuration = sample.durationSeconds ?? null
        entry.forwardFlow = sample.derivedFlowVph ?? null
      } else if (sample.direction === 'reverse') {
        entry.reverseDuration = sample.durationSeconds ?? null
        entry.reverseFlow = sample.derivedFlowVph ?? null
      }
    }

    return Array.from(series.values())
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((entry) => ({
        ...entry,
        label: new Date(entry.timestamp).toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
      }))
  }, [chartSegmentId, isChartOpen, samples, rangeStartMs, rangeEndMs])

  const hoveredDirectionOverlay = useMemo(() => {
    if (!hoveredSegmentKey) return null
    const dashIndex = hoveredSegmentKey.lastIndexOf('-')
    if (dashIndex === -1) return null
    const segmentId = hoveredSegmentKey.slice(0, dashIndex)
    const direction = hoveredSegmentKey.slice(dashIndex + 1)
    const sample = samplesForSnapshot.find(
      (item) => item.segmentId === segmentId && item.direction === direction,
    )
    if (!sample) return null
    const start = sample.origin
    const end = sample.destination
    if (!start || !end) return null
    const midpoint = computeMidpoint(start, end)
    const bearing = computeBearingDegrees(start, end)
    return { midpoint, bearing }
  }, [hoveredSegmentKey, samplesForSnapshot])

  const arrowIcon = useMemo(() => {
    if (!hoveredDirectionOverlay) return null
    const rotation = ((hoveredDirectionOverlay.bearing - 90) + 360) % 360
    return L.divIcon({
      className: 'direction-arrow-marker',
      html: `<div class="direction-arrow-marker__inner" style="transform: rotate(${rotation}deg)">➤</div>`
    })
  }, [hoveredDirectionOverlay])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="title-banner" style={{ backgroundImage: `url(${heroImage})` }}>
          <div className="title-overlay">
            <h1>Tre Torri Traffic Monitor</h1>
            <p>Visualise Google Routes travel times collected by the poller.</p>
          </div>
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
            <button
              type="button"
              className="doc-button"
              onClick={handleOpenDoc}
            >
              Flow estimation guide
            </button>
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
              const segmentKey = `${sample.segmentId}-${sample.direction}`
              const isActive = hoveredSegmentKey === segmentKey
              const positions: LatLngExpression[] = [
                [sample.origin.latitude, sample.origin.longitude],
                [sample.destination.latitude, sample.destination.longitude],
              ]

              return (
                <Polyline
                  key={segmentKey}
                  positions={positions}
                  pathOptions={{
                    color: isActive ? '#2563eb' : color,
                    weight: isActive ? weight + 3 : weight,
                    opacity: isActive ? 1 : 0.85,
                  }}
                  eventHandlers={{
                    click: () => handleMapSegmentClick(sample.segmentId, sample.direction),
                  }}
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
            {hoveredDirectionOverlay && arrowIcon && (
              <Marker
                position={[
                  hoveredDirectionOverlay.midpoint.latitude,
                  hoveredDirectionOverlay.midpoint.longitude,
                ]}
                icon={arrowIcon}
                interactive={false}
              />
            )}
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
            {groupedSegments.map((group) => (
              <SegmentCard
                key={group.segmentId}
                group={group}
                activeKey={hoveredSegmentKey}
                onHover={handleSegmentHover}
                onRequestChart={handleOpenChart}
                cardRef={(node) => {
                  if (node) {
                    segmentCardRefs.current[group.segmentId] = node
                  } else {
                    delete segmentCardRefs.current[group.segmentId]
                  }
                }}
              />
            ))}
         </div>
       </section>
      </main>

      {isChartOpen && chartGroup && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${chartGroup.segmentName} live time history`}
        >
          <div className="modal">
            <header className="modal-header">
              <h3>{chartGroup.segmentName} — live time history</h3>
              <button
                type="button"
                className="modal-close"
                onClick={handleCloseChart}
                aria-label="Close chart"
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              {chartData.length > 0 ? (
                <>
                  <h4 className="chart-subtitle">Travel time</h4>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart
                      data={chartData}
                      margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 6" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#475569' }} minTickGap={20} />
                      <YAxis
                        tick={{ fontSize: 12, fill: '#475569' }}
                        width={60}
                        label={{
                          value: 'seconds',
                          angle: -90,
                          position: 'insideLeft',
                          fill: '#475569',
                          fontSize: 12,
                        }}
                      />
                      <RechartsTooltip
                        labelStyle={{ fontWeight: 600 }}
                        formatter={(value) => {
                          if (Array.isArray(value)) {
                            return value
                          }
                          if (typeof value === 'number') {
                            return `${value}s`
                          }
                          return value ?? 'n/a'
                        }}
                      />
                      <RechartsLegend verticalAlign="top" height={28} />
                      <Line
                        type="monotone"
                        dataKey="forwardDuration"
                        name="Forward"
                        stroke="#2563eb"
                        strokeWidth={2.2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="reverseDuration"
                        name="Reverse"
                        stroke="#f97316"
                        strokeWidth={2.2}
                        dot={false}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>

                  <h4 className="chart-subtitle">Estimated flow</h4>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart
                      data={chartData}
                      margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 6" stroke="#e2e8f0" />
                      <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#475569' }} minTickGap={20} />
                      <YAxis
                        tick={{ fontSize: 12, fill: '#475569' }}
                        width={70}
                        label={{
                          value: 'veh/h',
                          angle: -90,
                          position: 'insideLeft',
                          fill: '#475569',
                          fontSize: 12,
                        }}
                      />
                      <RechartsTooltip
                        labelStyle={{ fontWeight: 600 }}
                        formatter={(value) => {
                          if (Array.isArray(value)) {
                            return value
                          }
                          if (typeof value === 'number') {
                            return `${Math.round(value)} veh/h`
                          }
                          return value ?? 'n/a'
                        }}
                      />
                      <RechartsLegend verticalAlign="top" height={28} />
                      <Line
                        type="monotone"
                        dataKey="forwardFlow"
                        name="Forward flow"
                        stroke="#2563eb"
                        strokeWidth={2.2}
                        dot={false}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="reverseFlow"
                        name="Reverse flow"
                        stroke="#f97316"
                        strokeWidth={2.2}
                        dot={false}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </>
              ) : (
                <p className="chart-empty">No samples available for this time range.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {isDocOpen && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Flow estimation guide"
        >
          <div className="modal">
            <header className="modal-header">
              <h3>Flow estimation guide</h3>
              <button
                type="button"
                className="modal-close"
                onClick={handleCloseDoc}
                aria-label="Close guide"
              >
                ×
              </button>
            </header>
            <div className="modal-body">
              <p>
                We infer directional vehicle flow using the Bureau of Public Roads (BPR) travel-time
                function:
              </p>
              <p>
                <code>t = t₀ × (1 + α (v/c)^β)</code>
              </p>
              <ul>
                <li>
                  <strong>t</strong> is the observed travel time, <strong>t₀</strong> is the free-flow time,
                  <strong>v</strong> is flow (veh/h), and <strong>c</strong> is capacity (veh/h).
                </li>
                <li>
                  We assume α = {BPR_ALPHA} and β = {BPR_BETA}, solve for <strong>v/c</strong>, and multiply by
                  the segment capacity.
                </li>
                <li>
                  Capacity defaults to <code>lanes × laneCapacityVph</code>; lane capacity comes from
                  `segments.js` (e.g., 900 veh/h for local lanes).
                </li>
                <li>
                  Length and free-flow speed use the geodesic distance between segment endpoints and the
                  static (baseline) travel time reported by Google.
                </li>
              </ul>
              <p>Confidence scores:</p>
              <ul>
                <li>
                  <strong>High</strong> — ratios ≤ 0.8 and complete data
                </li>
                <li>
                  <strong>Medium</strong> — ratios between 0.8 and 1.2
                </li>
                <li>
                  <strong>Low</strong> — missing data or heavy congestion (v/c &gt; 1.2)
                </li>
              </ul>
              <p>
                Re-run <code>npm run enrich</code> after updating raw samples or segment metadata to refresh
                these derived metrics.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
