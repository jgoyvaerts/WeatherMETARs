import { hasRawMetarToken } from "./raw-metar.server"

const MIN_CADENCE_MS = 25 * 60 * 1000
const MAX_CADENCE_MS = 120 * 60 * 1000
const CADENCE_ROUND_MS = 5 * 60 * 1000
const MIN_OBSERVATION_COUNT = 6
const GAP_TOLERANCE_MULTIPLIER = 1.5

export type StationDayGapObservation = {
  observedAtUtc: string
  rawText: string
}

export type StationDayObservationGap = {
  kind: "head" | "internal" | "tail"
  startedAtUtc: string
  endedAtUtc: string
  expectedCadenceMinutes: number
}

export function findStationDayObservationGaps(
  observations: StationDayGapObservation[],
  {
    startUtc,
    endUtc,
    minObservationCount = MIN_OBSERVATION_COUNT,
  }: {
    startUtc: string
    endUtc: string
    minObservationCount?: number
  }
): StationDayObservationGap[] {
  const startMs = Date.parse(startUtc)
  const endMs = Date.parse(endUtc)

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return []
  }

  const observedTimes = uniqueSortedObservationTimes(
    observations,
    startMs,
    endMs
  )

  if (observedTimes.length < minObservationCount) {
    return []
  }

  const cadenceMs = inferCadenceMs(observedTimes)
  if (cadenceMs === null) {
    return []
  }

  const gaps: StationDayObservationGap[] = []
  const thresholdMs = cadenceMs * GAP_TOLERANCE_MULTIPLIER
  const expectedCadenceMinutes = Math.round(cadenceMs / (60 * 1000))
  const firstObservedMs = observedTimes[0]
  const lastObservedMs = observedTimes[observedTimes.length - 1]

  if (firstObservedMs - startMs > thresholdMs) {
    gaps.push({
      kind: "head",
      startedAtUtc: formatUtc(new Date(startMs)),
      endedAtUtc: formatUtc(new Date(firstObservedMs)),
      expectedCadenceMinutes,
    })
  }

  for (let index = 1; index < observedTimes.length; index += 1) {
    const previousMs = observedTimes[index - 1]
    const currentMs = observedTimes[index]

    if (currentMs - previousMs > thresholdMs) {
      gaps.push({
        kind: "internal",
        startedAtUtc: formatUtc(new Date(previousMs + cadenceMs)),
        endedAtUtc: formatUtc(new Date(currentMs)),
        expectedCadenceMinutes,
      })
    }
  }

  if (endMs - lastObservedMs > thresholdMs) {
    gaps.push({
      kind: "tail",
      startedAtUtc: formatUtc(new Date(lastObservedMs + cadenceMs)),
      endedAtUtc: formatUtc(new Date(endMs)),
      expectedCadenceMinutes,
    })
  }

  return gaps.filter((gap) => gap.startedAtUtc < gap.endedAtUtc)
}

function uniqueSortedObservationTimes(
  observations: StationDayGapObservation[],
  startMs: number,
  endMs: number
) {
  const times = new Set<number>()

  for (const observation of observations) {
    if (hasRawMetarToken(observation.rawText, "MADISHF")) {
      continue
    }

    const observedMs = Date.parse(observation.observedAtUtc)
    if (
      Number.isFinite(observedMs) &&
      observedMs >= startMs &&
      observedMs < endMs
    ) {
      times.add(observedMs)
    }
  }

  return Array.from(times).sort((left, right) => left - right)
}

function inferCadenceMs(observedTimes: number[]) {
  const counts = new Map<number, number>()

  for (let index = 1; index < observedTimes.length; index += 1) {
    const roundedDeltaMs =
      Math.round(
        (observedTimes[index] - observedTimes[index - 1]) / CADENCE_ROUND_MS
      ) * CADENCE_ROUND_MS

    if (roundedDeltaMs < MIN_CADENCE_MS || roundedDeltaMs > MAX_CADENCE_MS) {
      continue
    }

    counts.set(roundedDeltaMs, (counts.get(roundedDeltaMs) ?? 0) + 1)
  }

  let bestCadenceMs: number | null = null
  let bestCount = 0

  for (const [cadenceMs, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount &&
        (bestCadenceMs === null || cadenceMs < bestCadenceMs))
    ) {
      bestCadenceMs = cadenceMs
      bestCount = count
    }
  }

  return bestCadenceMs
}

function formatUtc(date: Date) {
  return date.toISOString().replace(".000Z", "Z")
}
