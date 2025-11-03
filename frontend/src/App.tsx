import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { MapContainer, Marker, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import L, { type LatLngExpression, type LeafletMouseEvent } from 'leaflet'
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
  allowedDirections?: Array<'forward' | 'reverse'> | null
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
const SNAPSHOT_WINDOW_MINUTES = 5
const BPR_ALPHA = 0.15
const BPR_BETA = 4
const DATA_URL = `${import.meta.env.BASE_URL}traffic_samples.jsonl`

const CONFIG_ALLOWED_DIRECTION_OVERRIDES: Record<string, Array<'forward' | 'reverse'>> = {
  'via-milano': ['reverse'],
  'via-filippo-corridoni': ['forward'],
  'via-don-lorenzo-milani': ['forward'],
}

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
  allowedDirections: Array<'forward' | 'reverse'>
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
  forwardBaseline: number | null
  reverseBaseline: number | null
  forwardFlow: number | null
  reverseFlow: number | null
}

function MapCursorTracker({
  onMove,
  onLeave,
}: {
  onMove: (coordinate: Coordinate) => void
  onLeave: () => void
}) {
  const map = useMap()

  useEffect(() => {
    const handleMove = (event: LeafletMouseEvent) => {
      onMove({ latitude: event.latlng.lat, longitude: event.latlng.lng })
    }

    const handleOut = (event: LeafletMouseEvent) => {
      const related = (event.originalEvent as MouseEvent | undefined)?.relatedTarget
      if (!related || !(related instanceof Element) || !related.closest('.leaflet-container')) {
        onLeave()
      }
    }

    map.on('mousemove', handleMove)
    map.on('mouseout', handleOut)

    return () => {
      map.off('mousemove', handleMove)
      map.off('mouseout', handleOut)
    }
  }, [map, onMove, onLeave])

  return null
}

function formatTooltipTimestamp(ms: number): string {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function SegmentCard({ group, activeKey, onHover, onRequestChart, cardRef }: SegmentCardProps) {
  const allowedDirections = group.allowedDirections && group.allowedDirections.length > 0
    ? (group.allowedDirections as Array<'forward' | 'reverse'>)
    : (CONFIG_ALLOWED_DIRECTION_OVERRIDES[group.segmentId] as Array<'forward' | 'reverse'> | undefined) ??
      (['forward', 'reverse'] as Array<'forward' | 'reverse'>)
  const allowedSet = new Set(allowedDirections)
  const visibleDirections = group.directions
    .slice()
    .filter((sample) => allowedSet.has(sample.direction as 'forward' | 'reverse'))
    .sort((a, b) => a.direction.localeCompare(b.direction))
  const baseSample = visibleDirections[0] ?? null
  const isGroupActive = visibleDirections.some(
    (sample) => `${sample.segmentId}-${sample.direction}` === activeKey,
  )
  const weather = baseSample?.weather ?? null
  const lengthMeters = baseSample?.lengthMeters ?? null
  const capacityVph = baseSample?.capacityVph ?? null
  const freeFlowSpeedKph = baseSample?.freeFlowSpeedKph ?? null
  const isOneWay = allowedDirections.length === 1
  const oneWayDirection = isOneWay ? allowedDirections[0] : null
  let oneWayLabel: string | null = null
  if (isOneWay && oneWayDirection) {
    if (oneWayDirection === 'forward' && baseSample) {
      oneWayLabel = `Forward only (${formatCoordinate(baseSample.origin)} → ${formatCoordinate(
        baseSample.destination,
      )})`
    } else if (oneWayDirection === 'reverse' && baseSample) {
      oneWayLabel = `Reverse only (${formatCoordinate(baseSample.destination)} ← ${formatCoordinate(
        baseSample.origin,
      )})`
    } else {
      oneWayLabel = oneWayDirection === 'forward' ? 'Forward only' : 'Reverse only'
    }
  }

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
          {isOneWay && oneWayLabel && (
            <span className="segment-oneway" aria-label={`One-way: ${oneWayLabel}`}>
              🚦 {oneWayLabel}
            </span>
          )}
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
        {visibleDirections.map((sample) => {
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
        {visibleDirections.length === 0 && (
          <p className="segment-no-data">No active directions for this segment.</p>
        )}
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
  const [pollStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [timePreset, setTimePreset] = useState<TimeWindowPreset>('LAST_48_HOURS')
  const [customStart, setCustomStart] = useState<string>('')
  const [customEnd, setCustomEnd] = useState<string>('')
  const [hoveredSegmentKey, setHoveredSegmentKey] = useState<string | null>(null)
  const [chartSegmentId, setChartSegmentId] = useState<string | null>(null)
  const segmentCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const [isChartOpen, setIsChartOpen] = useState(false)
  const [isDocOpen, setIsDocOpen] = useState(false)
  const [isPlaybackActive, setIsPlaybackActive] = useState(false)
  const playbackIntervalRef = useRef<number | null>(null)
  const [chartRangeStartMs, setChartRangeStartMs] = useState<number | null>(null)
  const [chartRangeEndMs, setChartRangeEndMs] = useState<number | null>(null)
  const [mapCursorCoordinate, setMapCursorCoordinate] = useState<Coordinate | null>(null)
  const [guideLanguage, setGuideLanguage] = useState<'en' | 'it'>('en')

  const autogrillIcon = useMemo(
    () =>
      L.icon({
        iconUrl: new URL('./assets/autogrill-logo.svg', import.meta.url).href,
        iconSize: [36, 36],
        iconAnchor: [18, 18],
        popupAnchor: [0, -18],
        className: 'autogrill-icon',
      }),
    [],
  )

  const latestAllowedDirections = useMemo(() => {
    const map = new Map<string, { directions: Array<'forward' | 'reverse'>; timestamp: number }>()
    for (const sample of samples) {
      if (!Array.isArray(sample.allowedDirections) || sample.allowedDirections.length === 0) {
        continue
      }
      const normalized = sample.allowedDirections.filter(
        (dir): dir is 'forward' | 'reverse' => dir === 'forward' || dir === 'reverse',
      )
      if (normalized.length === 0) continue
      const requestedAt = new Date(sample.requestedAt).getTime()
      const existing = map.get(sample.segmentId)
      if (!existing || requestedAt > existing.timestamp) {
        map.set(sample.segmentId, { directions: normalized, timestamp: requestedAt })
      }
    }
    for (const [segmentId, directions] of Object.entries(CONFIG_ALLOWED_DIRECTION_OVERRIDES)) {
      if (!map.has(segmentId)) {
        map.set(segmentId, { directions, timestamp: Number.NEGATIVE_INFINITY })
      }
    }
    return new Map<string, Array<'forward' | 'reverse'>>(
      Array.from(map.entries(), ([segmentId, value]) => [segmentId, value.directions]),
    )
  }, [samples])

  const handleMapCursorMove = useCallback((coordinate: Coordinate) => {
    setMapCursorCoordinate(coordinate)
  }, [])

  const handleMapCursorLeave = useCallback(() => {
    setMapCursorCoordinate(null)
  }, [])

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
      if (isPlaybackActive) {
        setIsPlaybackActive(false)
      }
      return
    }

    const exists = snapshotKey
      ? visibleSnapshotGroupsAsc.some((group) => group.key === snapshotKey)
      : false

    if (!exists) {
      setSnapshotKey(visibleSnapshotGroupsDesc[0].key)
    }
  }, [snapshotKey, visibleSnapshotGroupsAsc, visibleSnapshotGroupsDesc, isPlaybackActive])

  useEffect(() => {
    if (!isPlaybackActive) {
      if (playbackIntervalRef.current != null) {
        window.clearInterval(playbackIntervalRef.current)
        playbackIntervalRef.current = null
      }
      return
    }

    if (visibleSnapshotGroupsAsc.length === 0) {
      setIsPlaybackActive(false)
      return
    }

    if (!snapshotKey) {
      setSnapshotKey(visibleSnapshotGroupsAsc[0].key)
    }

    const intervalId = window.setInterval(() => {
      setSnapshotKey((currentKey) => {
        if (visibleSnapshotGroupsAsc.length === 0) {
          return currentKey
        }
        const currentIndex = currentKey
          ? visibleSnapshotGroupsAsc.findIndex((group) => group.key === currentKey)
          : -1
        const nextIndex = currentIndex >= 0
          ? (currentIndex + 1) % visibleSnapshotGroupsAsc.length
          : 0
        return visibleSnapshotGroupsAsc[nextIndex]?.key ?? currentKey
      })
    }, 2000)

    playbackIntervalRef.current = intervalId

    return () => {
      window.clearInterval(intervalId)
      playbackIntervalRef.current = null
    }
  }, [isPlaybackActive, visibleSnapshotGroupsAsc, snapshotKey])

  useEffect(() => {
    return () => {
      if (playbackIntervalRef.current != null) {
        window.clearInterval(playbackIntervalRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (loadState === 'loading' && isPlaybackActive) {
      setIsPlaybackActive(false)
    }
  }, [loadState, isPlaybackActive])

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

  const handleTogglePlayback = useCallback(() => {
    if (visibleSnapshotGroupsAsc.length === 0 || loadState === 'loading') {
      return
    }
    setIsPlaybackActive((prev) => !prev)
  }, [visibleSnapshotGroupsAsc, loadState])

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
        allowedDirections: Array<'forward' | 'reverse'>
      }
    >()
    for (const sample of samplesForSnapshot) {
      const overrideAllowed = CONFIG_ALLOWED_DIRECTION_OVERRIDES[sample.segmentId]
      const sampleAllowed =
        Array.isArray(sample.allowedDirections) && sample.allowedDirections.length > 0
          ? (sample.allowedDirections as Array<'forward' | 'reverse'>)
          : undefined
      const fallbackLatest = latestAllowedDirections.get(sample.segmentId) as
        | Array<'forward' | 'reverse'>
        | undefined

      const existing = groups.get(sample.segmentId)
      if (!existing) {
        const initialAllowed =
          overrideAllowed ?? sampleAllowed ?? fallbackLatest ?? (['forward', 'reverse'] as Array<'forward' | 'reverse'>)

        groups.set(sample.segmentId, {
          segmentId: sample.segmentId,
          segmentName: sample.segmentName,
          directions: new Map<'forward' | 'reverse', TrafficSample>(),
          allowedDirections: initialAllowed,
        })
      }
      const groupEntry = groups.get(sample.segmentId)!
      if (overrideAllowed && overrideAllowed.join('|') !== groupEntry.allowedDirections.join('|')) {
        groupEntry.allowedDirections = overrideAllowed
      } else if (
        !overrideAllowed &&
        sampleAllowed &&
        sampleAllowed.join('|') !== groupEntry.allowedDirections.join('|')
      ) {
        groupEntry.allowedDirections = sampleAllowed
      }
      const prev = groupEntry.directions.get(sample.direction as 'forward' | 'reverse')
      if (!prev || new Date(sample.requestedAt) > new Date(prev.requestedAt)) {
        groupEntry.directions.set(sample.direction as 'forward' | 'reverse', sample)
      }
    }
    return Array.from(groups.values())
      .map(({ segmentId, segmentName, directions, allowedDirections }) => ({
        segmentId,
        segmentName,
        directions: Array.from(directions.values()),
        allowedDirections,
      }))
      .sort((a, b) => a.segmentName.localeCompare(b.segmentName))
  }, [samplesForSnapshot, latestAllowedDirections])

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

  const segmentsCount = groupedSegments.length
  const latestSnapshotLabel = visibleSnapshotGroupsDesc[0]
    ? formatSnapshotRange(visibleSnapshotGroupsDesc[0].key)
    : 'n/a'

  const chartAllPoints: ChartPoint[] = useMemo(() => {
    if (!chartSegmentId || !isChartOpen) return []

    const points: ChartPoint[] = []

    for (const group of snapshotGroupsAsc) {
      const bucketTime = new Date(group.key)
      const bucketMs = bucketTime.getTime()
      if (Number.isNaN(bucketMs)) continue

      let forwardSample: TrafficSample | undefined
      let reverseSample: TrafficSample | undefined
      let directionsFromSamples: Array<'forward' | 'reverse'> | null = null

      for (const sample of group.samples) {
        if (sample.segmentId !== chartSegmentId) continue
        if (directionsFromSamples == null && Array.isArray(sample.allowedDirections)) {
          directionsFromSamples = sample.allowedDirections.filter((dir): dir is 'forward' | 'reverse' =>
            dir === 'forward' || dir === 'reverse'
          )
        }
        if (sample.direction === 'forward') {
          forwardSample = sample
        } else if (sample.direction === 'reverse') {
          reverseSample = sample
        }
      }

      const overrideAllowed = CONFIG_ALLOWED_DIRECTION_OVERRIDES[chartSegmentId]
      const fallbackLatest = latestAllowedDirections.get(chartSegmentId) as
        | Array<'forward' | 'reverse'>
        | undefined
      const effectiveAllowed =
        overrideAllowed ??
        directionsFromSamples ??
        fallbackLatest ??
        (['forward', 'reverse'] as Array<'forward' | 'reverse'>)
      const allowedSet = new Set<'forward' | 'reverse'>(effectiveAllowed)

      if (!forwardSample && !reverseSample) {
        continue
      }

      points.push({
        timestamp: bucketMs,
        label: formatTooltipTimestamp(bucketMs),
        forwardDuration: allowedSet.has('forward') ? forwardSample?.durationSeconds ?? null : null,
        reverseDuration: allowedSet.has('reverse') ? reverseSample?.durationSeconds ?? null : null,
        forwardBaseline: allowedSet.has('forward') ? forwardSample?.staticDurationSeconds ?? null : null,
        reverseBaseline: allowedSet.has('reverse') ? reverseSample?.staticDurationSeconds ?? null : null,
        forwardFlow: allowedSet.has('forward') ? forwardSample?.derivedFlowVph ?? null : null,
        reverseFlow: allowedSet.has('reverse') ? reverseSample?.derivedFlowVph ?? null : null,
      })
    }

    return points.sort((a, b) => a.timestamp - b.timestamp)
  }, [chartSegmentId, isChartOpen, snapshotGroupsAsc, latestAllowedDirections])

  const chartBasePoints = chartAllPoints

  useEffect(() => {
    if (!isChartOpen) {
      setChartRangeStartMs(null)
      setChartRangeEndMs(null)
      return
    }
    if (chartBasePoints.length === 0) {
      setChartRangeStartMs(null)
      setChartRangeEndMs(null)
      return
    }
    const earliest = chartBasePoints[0]?.timestamp ?? null
    const latest = chartBasePoints[chartBasePoints.length - 1]?.timestamp ?? null
    setChartRangeStartMs(earliest)
    setChartRangeEndMs(latest)
  }, [isChartOpen, chartSegmentId, chartBasePoints])

  const chartData: ChartPoint[] = useMemo(() => {
    if (!chartSegmentId || !isChartOpen) return []

    const filtered = chartBasePoints.filter((point) => {
      if (chartRangeStartMs != null && point.timestamp < chartRangeStartMs) return false
      if (chartRangeEndMs != null && point.timestamp > chartRangeEndMs) return false
      return true
    })

    if (filtered.length <= 1) {
      return filtered
    }

    const gapThresholdMs = SNAPSHOT_WINDOW_MINUTES * 2 * 60 * 1000
    const withBreaks: ChartPoint[] = []

    for (let i = 0; i < filtered.length; i += 1) {
      const current = filtered[i]
      withBreaks.push(current)
      const next = filtered[i + 1]
      if (!next) continue
      const delta = next.timestamp - current.timestamp
      if (delta > gapThresholdMs) {
        const breakpointTs = current.timestamp + Math.floor(delta / 2)
        withBreaks.push({
          timestamp: breakpointTs,
          label: formatTooltipTimestamp(breakpointTs),
          forwardDuration: null,
          reverseDuration: null,
          forwardBaseline: null,
          reverseBaseline: null,
          forwardFlow: null,
          reverseFlow: null,
        })
      }
    }

    return withBreaks
  }, [chartSegmentId, isChartOpen, chartBasePoints, chartRangeStartMs, chartRangeEndMs])

  const availableChartDays = useMemo(() => {
    const map = new Map<string, { key: string; label: string; start: number }>()
    for (const point of chartAllPoints) {
      const date = new Date(point.timestamp)
      if (Number.isNaN(date.getTime())) continue
      const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
      const key = new Date(startOfDay).toISOString().slice(0, 10)
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          start: startOfDay,
        })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.start - b.start)
  }, [chartAllPoints])

  const activeChartDayKey = useMemo(() => {
    if (chartRangeStartMs == null || chartRangeEndMs == null) return null
    const startDate = new Date(chartRangeStartMs)
    const endDate = new Date(chartRangeEndMs)
    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return null
    const sameDay =
      startDate.getFullYear() === endDate.getFullYear() &&
      startDate.getMonth() === endDate.getMonth() &&
      startDate.getDate() === endDate.getDate() &&
      chartRangeEndMs - chartRangeStartMs <= 24 * 60 * 60 * 1000
    if (!sameDay) return null
    const startOfDay = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime()
    return new Date(startOfDay).toISOString().slice(0, 10)
  }, [chartRangeStartMs, chartRangeEndMs])

  const handleSelectChartDay = useCallback(
    (day: { key: string; start: number }) => {
      const start = day.start
      const end = start + 24 * 60 * 60 * 1000 - 1
      setChartRangeStartMs(start)
      setChartRangeEndMs(end)
    },
    [],
  )

  const chartDomain: [number, number] | ['auto', 'auto'] = useMemo(() => {
    if (!isChartOpen || !chartSegmentId || chartBasePoints.length === 0) {
      return ['auto', 'auto']
    }

    const defaultStart = chartBasePoints[0]?.timestamp ?? null
    const defaultEnd = chartBasePoints[chartBasePoints.length - 1]?.timestamp ?? null
    const start = chartRangeStartMs ?? defaultStart
    const end = chartRangeEndMs ?? defaultEnd
    if (start == null || end == null || start >= end) {
      return ['auto', 'auto']
    }
    return [start, end]
  }, [chartBasePoints, chartSegmentId, isChartOpen, chartRangeStartMs, chartRangeEndMs])

  const chartRangeStartValue = chartRangeStartMs != null
    ? formatDatetimeLocalInput(new Date(chartRangeStartMs))
    : ''
  const chartRangeEndValue = chartRangeEndMs != null
    ? formatDatetimeLocalInput(new Date(chartRangeEndMs))
    : ''

  const handleChartRangeStartChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value
      if (!value) {
        setChartRangeStartMs(null)
        return
      }
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) return
      const ms = parsed.getTime()
      const earliest = chartBasePoints[0]?.timestamp ?? null
      const latest = chartBasePoints[chartBasePoints.length - 1]?.timestamp ?? null
      let nextStart = ms
      if (earliest != null && nextStart < earliest) {
        nextStart = earliest
      }
      if (latest != null && nextStart > latest) {
        nextStart = latest
      }
      setChartRangeStartMs(nextStart)
      setChartRangeEndMs((prev) => {
        if (prev != null && prev < nextStart) {
          return nextStart
        }
        return prev
      })
    },
    [chartBasePoints],
  )

  const handleChartRangeEndChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value
      if (!value) {
        setChartRangeEndMs(null)
        return
      }
      const parsed = new Date(value)
      if (Number.isNaN(parsed.getTime())) return
      const ms = parsed.getTime()
      const earliest = chartBasePoints[0]?.timestamp ?? null
      const latest = chartBasePoints[chartBasePoints.length - 1]?.timestamp ?? null
      let nextEnd = ms
      if (earliest != null && nextEnd < earliest) {
        nextEnd = earliest
      }
      if (latest != null && nextEnd > latest) {
        nextEnd = latest
      }
      setChartRangeEndMs(nextEnd)
      setChartRangeStartMs((prev) => {
        if (prev != null && prev > nextEnd) {
          return nextEnd
        }
        return prev
      })
    },
    [chartBasePoints],
  )

  const handleChartRangeReset = useCallback(() => {
    if (chartBasePoints.length === 0) return
    const earliest = chartBasePoints[0]?.timestamp ?? null
    const latest = chartBasePoints[chartBasePoints.length - 1]?.timestamp ?? null
    setChartRangeStartMs(earliest)
    setChartRangeEndMs(latest)
  }, [chartBasePoints])

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
            <div className="title-heading">
              <h1>Tre Torri Traffic Monitor</h1>
              <button
                type="button"
                className="doc-button doc-button--icon"
                onClick={handleOpenDoc}
                aria-label="Flow estimation guide"
                title="Flow estimation guide"
              >
                ?
              </button>
            </div>
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
            <div className="playback-control">
              <button
                type="button"
                className={`playback-button${isPlaybackActive ? ' is-active' : ''}`}
                onClick={handleTogglePlayback}
                disabled={visibleSnapshotGroupsAsc.length === 0 || loadState === 'loading'}
                aria-label={isPlaybackActive ? 'Stop playback' : 'Play timeline'}
                title={isPlaybackActive ? 'Stop timeline playback' : 'Play timeline playback'}
              >
                {isPlaybackActive ? '⏹ Stop' : '▶ Play'}
              </button>
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
          {pollStatus && (
            <div className="poll-status-strip">
              <span className={`poll-status ${pollStatus.type === 'error' ? 'error' : 'success'}`}>
                {pollStatus.message}
              </span>
            </div>
          )}
        </div>
      </header>

      {loadState === 'loading' && <p className="status">Loading traffic samples…</p>}
      {loadState === 'error' && <p className="status error">{error}</p>}

      <main className="content">
        <section className="map-section">
          <div className="map-wrapper">
            <MapContainer center={MAP_CENTER} zoom={MAP_ZOOM} scrollWheelZoom style={{ height: '100%', width: '100%' }}>
              <MapCursorTracker onMove={handleMapCursorMove} onLeave={handleMapCursorLeave} />
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
              const overrideAllowed = CONFIG_ALLOWED_DIRECTION_OVERRIDES[sample.segmentId]
              const allowedDirectionsSample =
                overrideAllowed ??
                (Array.isArray(sample.allowedDirections) && sample.allowedDirections.length > 0
                  ? sample.allowedDirections
                  : ['forward', 'reverse'])
              if (!allowedDirectionsSample.includes(sample.direction as 'forward' | 'reverse')) {
                return null
              }
              const isOneWaySample = allowedDirectionsSample.length === 1

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
                      {isOneWaySample && (
                        <>
                          <br />
                          One-way · {allowedDirectionsSample[0] === 'forward' ? 'Forward only' : 'Reverse only'}
                        </>
                      )}
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
            <Polyline
              positions={[
                [45.5165, 9.3202],
                [45.5184, 9.3200],
                [45.5186, 9.3227],
              ]}
              pathOptions={{ color: '#2563eb', weight: 4, opacity: 0.7, dashArray: '8 6' }}
            >
              <Tooltip sticky direction="top" offset={[0, -12]}>
                Simulazione Bypass Per Leonardo Da Vinci
              </Tooltip>
            </Polyline>
            <Marker position={[45.5188, 9.321]} icon={autogrillIcon}>
              <Tooltip direction="top" offset={[0, -12]} opacity={1} permanent>
                Autogrill*
              </Tooltip>
            </Marker>
          </MapContainer>
        </div>
          <div className="map-meta">
            <div className="map-coordinates">
              <span>Cursor</span>
              <strong>
                {mapCursorCoordinate
                  ? formatCoordinate(mapCursorCoordinate)
                  : 'Move cursor over map'}
              </strong>
            </div>
            <aside className="legend">
              <div className="legend-header">
                <h2>Legend</h2>
                <div className="legend-info">
                  <span><strong>Segments:</strong> {segmentsCount}</span>
                  <span><strong>Latest snapshot:</strong> {latestSnapshotLabel}</span>
                </div>
              </div>
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
          </div>
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
              <div className="chart-help">
                <span className="chart-help__icon" tabIndex={0} aria-label="How to read this chart">
                  ?
                  <span className="chart-help__tooltip">
                    <strong>Live time</strong> (solid lines) is what drivers face now.
                    <br />
                    <strong>Free-flow</strong> (dashed) is Google’s baseline with no traffic. When live time rides well above free-flow the link is congested.
                    <br />
                    We track <strong>forward vs reverse</strong> legs separately to spot one-way style behaviour or directional choke points.
                    <br />
                    Any gaps? They mean the poller didn’t run then, so we leave the line open instead of faking data.
                  </span>
                </span>
              </div>
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
                  {availableChartDays.length > 0 && (
                    <div className="chart-available-days" aria-label="Available days with data">
                      {availableChartDays.map((day) => (
                        <button
                          type="button"
                          key={day.key}
                          className={`chart-day-button${activeChartDayKey === day.key ? ' is-active' : ''}`}
                          onClick={() => handleSelectChartDay(day)}
                        >
                          {day.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="chart-range-controls">
                    <label htmlFor="chart-range-start">
                      Start
                      <input
                        id="chart-range-start"
                        type="datetime-local"
                        value={chartRangeStartValue}
                        min={chartBasePoints[0] ? formatDatetimeLocalInput(new Date(chartBasePoints[0].timestamp)) : undefined}
                        max={chartBasePoints.length > 0 ? formatDatetimeLocalInput(new Date(chartBasePoints[chartBasePoints.length - 1].timestamp)) : undefined}
                        onChange={handleChartRangeStartChange}
                      />
                    </label>
                    <label htmlFor="chart-range-end">
                      End
                      <input
                        id="chart-range-end"
                        type="datetime-local"
                        value={chartRangeEndValue}
                        min={chartBasePoints[0] ? formatDatetimeLocalInput(new Date(chartBasePoints[0].timestamp)) : undefined}
                        max={chartBasePoints.length > 0 ? formatDatetimeLocalInput(new Date(chartBasePoints[chartBasePoints.length - 1].timestamp)) : undefined}
                        onChange={handleChartRangeEndChange}
                      />
                    </label>
                    <button type="button" className="chart-range-reset" onClick={handleChartRangeReset}>
                      Reset
                    </button>
                  </div>
                  <h4 className="chart-subtitle">Travel time</h4>
                  <ResponsiveContainer width="100%" height={240}>
                    <LineChart
                      data={chartData}
                      margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
                    >
                      <CartesianGrid strokeDasharray="3 6" stroke="#e2e8f0" />
                      <XAxis
                        type="number"
                        dataKey="timestamp"
                        domain={chartDomain}
                        tick={{ fontSize: 12, fill: '#475569' }}
                        tickFormatter={(value) => formatTooltipTimestamp(value)}
                        minTickGap={20}
                      />
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
                        labelFormatter={(value) => formatTooltipTimestamp(value as number)}
                      />
                      <RechartsLegend verticalAlign="top" height={28} />
                      <Line
                        type="monotone"
                        dataKey="forwardBaseline"
                        name="Forward free-flow"
                        stroke="#60a5fa"
                        strokeWidth={1.5}
                        strokeDasharray="5 5"
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="forwardDuration"
                        name="Forward"
                        stroke="#2563eb"
                        strokeWidth={2.2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="reverseDuration"
                        name="Reverse"
                        stroke="#f97316"
                        strokeWidth={2.2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="reverseBaseline"
                        name="Reverse free-flow"
                        stroke="#fbbf24"
                        strokeWidth={1.5}
                        strokeDasharray="5 5"
                        dot={false}
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
                      <XAxis
                        type="number"
                        dataKey="timestamp"
                        domain={chartDomain}
                        tick={{ fontSize: 12, fill: '#475569' }}
                        tickFormatter={(value) => formatTooltipTimestamp(value)}
                        minTickGap={20}
                      />
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
                        labelFormatter={(value) => formatTooltipTimestamp(value as number)}
                      />
                      <RechartsLegend verticalAlign="top" height={28} />
                      <Line
                        type="monotone"
                        dataKey="forwardFlow"
                        name="Forward flow"
                        stroke="#2563eb"
                        strokeWidth={2.2}
                        dot={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="reverseFlow"
                        name="Reverse flow"
                        stroke="#f97316"
                        strokeWidth={2.2}
                        dot={false}
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
              <h3>Usage & assumptions</h3>
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
              <div className="guide-language">
                <button
                  type="button"
                  className={`guide-language__button${guideLanguage === 'en' ? ' is-active' : ''}`}
                  onClick={() => setGuideLanguage('en')}
                  aria-label="English guide"
                >
                  🇬🇧
                </button>
                <button
                  type="button"
                  className={`guide-language__button${guideLanguage === 'it' ? ' is-active' : ''}`}
                  onClick={() => setGuideLanguage('it')}
                  aria-label="Guida in italiano"
                >
                  🇮🇹
                </button>
              </div>

              {guideLanguage === 'en' ? (
                <div className="guide-content">
                  <h4>Why this dashboard?</h4>
                  <p>
                    Tre Torri is evaluating circulation changes, especially converting selected streets to
                    one-way operation. This tool lets us monitor observed Google Routes travel times so we
                    can compare baseline behaviour with future scenarios.
                  </p>

                  <h4>How to explore the data</h4>
                  <ul>
                    <li>Use the range presets or slider to move through snapshots (5-minute buckets).</li>
                    <li>
                      Hover segments on the map or list to reveal live/free-flow durations, direction, and
                      whether the street is currently one-way.
                    </li>
                    <li>
                      Open the chart (📈) to see time-series of travel time, free-flow baselines, and flow
                      estimates for the active segment.
                    </li>
                    <li>
                      Click a road on the map to jump to its card in the right-hand panel and highlight the
                      corresponding direction.
                    </li>
                    <li>
                      Cursor coordinates appear beside the legend — copy them when defining new segments.
                    </li>
                  </ul>

                  <h4>Flow estimation model</h4>
                  <p>
                    We infer directional flow using the Bureau of Public Roads (BPR) travel-time function:
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
                      <strong>Calibration pending:</strong> these α/β defaults have not yet been tuned with the
                      2023 manual traffic counts. Once those observations are released we will recalibrate the
                      model against the measured flows.
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
                  <footer className="guide-footer">
                    <p>
                      Sources: Google Maps Routes API (live traffic, static baselines).
                      <br />
                      Ing. Thimoty Barbieri – <a href="mailto:thimoty.barbieri@gmail.com">thimoty.barbieri@gmail.com</a>
                    </p>
                  </footer>
                </div>
              ) : (
                <div className="guide-content">
                  <h4>Perché questo cruscotto?</h4>
                  <p>
                    Il quartiere Tre Torri sta valutando modifiche alla circolazione, in particolare la
                    trasformazione di alcune strade in sensi unici. Questo strumento consente di monitorare i
                    tempi di percorrenza osservati su Google Routes per confrontare il comportamento attuale con
                    gli scenari futuri.
                  </p>

                  <h4>Come esplorare i dati</h4>
                  <ul>
                    <li>Usa i preset oppure lo slider per navigare tra le finestre temporali (blocchi da 5 minuti).</li>
                    <li>
                      Passa il mouse sulle strade nella mappa o nell’elenco per vedere durate live/free-flow,
                      direzione e se il segmento è attualmente a senso unico.
                    </li>
                    <li>
                      Apri il grafico (📈) per consultare le serie storiche dei tempi di viaggio, dei free-flow e
                      delle stime di flusso per il segmento selezionato.
                    </li>
                    <li>
                      Clicca sulla strada nella mappa per aprire la scheda corrispondente nel pannello a destra e
                      metterne in evidenza la direzione.
                    </li>
                    <li>
                      Le coordinate del cursore compaiono accanto alla legenda: copiale quando devi definire
                      nuovi segmenti.
                    </li>
                  </ul>

                  <h4>Modello di stima del flusso</h4>
                  <p>
                    Stimiamo il flusso direzionale usando la funzione di BPR (Bureau of Public Roads):
                  </p>
                  <p>
                    <code>t = t₀ × (1 + α (v/c)^β)</code>
                  </p>
                  <ul>
                    <li>
                      <strong>t</strong> è il tempo osservato, <strong>t₀</strong> quello in condizioni libere,
                      <strong>v</strong> è il flusso (veh/h) e <strong>c</strong> è la capacità (veh/h).
                    </li>
                    <li>
                      Assumiamo α = {BPR_ALPHA} e β = {BPR_BETA}; risolviamo per <strong>v/c</strong> e moltiplichiamo per
                      la capacità del segmento.
                    </li>
                    <li>
                      <strong>Calibrazione in attesa:</strong> questi valori α/β non sono ancora tarati con i conteggi
                      manuali 2023. Quando saranno disponibili, ricalibreremo il modello.
                    </li>
                    <li>
                      La capacità deriva da <code>corsie × laneCapacityVph</code>; i valori di riferimento sono in
                      `segments.js`.
                    </li>
                    <li>
                      Lunghezza e velocità free-flow usano la distanza geodetica tra gli estremi e la durata statica
                      fornita da Google.
                    </li>
                  </ul>
                  <p>Livelli di confidenza:</p>
                  <ul>
                    <li>
                      <strong>Alta</strong> — rapporto ≤ 0.8 e dati completi
                    </li>
                    <li>
                      <strong>Media</strong> — rapporto tra 0.8 e 1.2
                    </li>
                    <li>
                      <strong>Bassa</strong> — dati mancanti o congestione elevata (v/c &gt; 1.2)
                    </li>
                  </ul>
                  <p>
                    Esegui <code>npm run enrich</code> dopo aver aggiornato i campioni grezzi o i metadati dei segmenti per
                    rigenerare queste metriche.
                  </p>
                  <footer className="guide-footer">
                    <p>
                      Fonti: Google Maps Routes API (traffico live, baseline statiche).
                      <br />
                      Ing. Thimoty Barbieri – <a href="mailto:thimoty.barbieri@gmail.com">thimoty.barbieri@gmail.com</a>
                    </p>
                  </footer>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}
