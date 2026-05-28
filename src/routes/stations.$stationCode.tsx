import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { InteractiveBrokersIcon } from "@/components/interactive-brokers-icon"
import { ObservationsTable } from "@/components/observations-table"
import { PolymarketIcon } from "@/components/polymarket-icon"
import { RobinhoodIcon } from "@/components/robinhood-icon"
import { StationSearch } from "@/components/station-search"
import { TemperatureChart } from "@/components/temperature-chart"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { getStationDay } from "@/lib/weather/weather.functions"
import { formatTemperature } from "@/lib/weather/units"
import type { TemperatureUnit } from "@/lib/weather/types"

export const Route = createFileRoute("/stations/$stationCode")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
  }),
  loaderDeps: ({ search }) => ({
    date: search.date,
  }),
  loader: ({ params, deps }) =>
    getStationDay({
      data: {
        stationCode: params.stationCode,
        date: deps.date,
      },
    }),
  component: StationRoute,
})

function StationRoute() {
  const data = Route.useLoaderData()
  const params = Route.useParams()
  const navigate = Route.useNavigate()
  const [unit, setUnit] = React.useState<TemperatureUnit>("c")
  const [dateInput, setDateInput] = React.useState(data.localDate)
  const station = data.station
  const previousDate = addIsoDays(data.localDate, -1)
  const nextDate = addIsoDays(data.localDate, 1)
  const canGoPrevious = previousDate >= data.dateNavigation.minDate
  const canGoNext = nextDate <= data.dateNavigation.maxDate
  const temperatureStatDate =
    data.dayCoverage.status === "current"
      ? `${data.localDate} (so far)`
      : data.localDate

  React.useEffect(() => {
    setDateInput(data.localDate)
  }, [data.localDate])

  function navigateToDate(date: string | undefined) {
    return navigate({
      to: "/stations/$stationCode",
      params: { stationCode: station?.stationCode ?? params.stationCode },
      search: { date },
    })
  }

  function updateDateInput(value: string) {
    setDateInput(value)

    const date = value.trim()
    if (
      isAllowedDate(
        date,
        data.dateNavigation.minDate,
        data.dateNavigation.maxDate
      ) &&
      date !== data.localDate
    ) {
      void navigateToDate(date)
    }
  }

  function commitDateInput() {
    const date = dateInput.trim()

    if (date === "") {
      void navigateToDate(undefined)
      return
    }

    if (
      !isAllowedDate(
        date,
        data.dateNavigation.minDate,
        data.dateNavigation.maxDate
      )
    ) {
      setDateInput(data.localDate)
      return
    }

    setDateInput(date)

    if (date !== data.localDate) {
      void navigateToDate(date)
    }
  }

  if (!station) {
    return (
      <main className="min-h-svh bg-background px-6 py-8">
        <div className="mx-auto max-w-5xl space-y-8">
          <HomeLogoLink />
          <Alert variant="destructive">
            <AlertTitle>Station not found</AlertTitle>
            <AlertDescription>
              {params.stationCode.toUpperCase()} is not present in the local
              station index. Run the METAR worker or `bun run ingest:once` to
              sync NOAA station metadata.
            </AlertDescription>
          </Alert>
          <StationSearch compact />
        </div>
      </main>
    )
  }

  return (
    <main className="min-h-svh bg-background px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-8">
        <header className="space-y-5 border-b pb-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <HomeLogoLink />
            <div className="w-full sm:w-80 lg:w-96">
              <StationSearch compact />
            </div>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-semibold tracking-normal sm:text-5xl">
                  {station.stationCode}
                </h1>
                {station.country ? (
                  <Badge variant="secondary">{station.country}</Badge>
                ) : null}
                {data.predictionMarketUrls.polymarket ? (
                  <PredictionMarketIconLink
                    href={data.predictionMarketUrls.polymarket}
                    label={`Open Polymarket market for ${station.stationCode} on ${data.localDate}`}
                  >
                    <PolymarketIcon className="size-3.5" />
                  </PredictionMarketIconLink>
                ) : null}
                {data.predictionMarketUrls.interactiveBrokers ? (
                  <PredictionMarketIconLink
                    href={data.predictionMarketUrls.interactiveBrokers}
                    label="Open Interactive Brokers prediction markets"
                  >
                    <InteractiveBrokersIcon className="size-3.5" />
                  </PredictionMarketIconLink>
                ) : null}
                {data.predictionMarketUrls.robinhood ? (
                  <PredictionMarketIconLink
                    href={data.predictionMarketUrls.robinhood}
                    label={`Open Robinhood market for ${station.stationCode} on ${data.localDate}`}
                  >
                    <RobinhoodIcon className="size-3.5" />
                  </PredictionMarketIconLink>
                ) : null}
                <Badge variant="outline">{station.timezone}</Badge>
              </div>
              <p className="max-w-3xl text-muted-foreground">
                {[station.name, station.state].filter(Boolean).join(", ")}
              </p>
            </div>

            <div className="lg:pb-1">
              <div className="flex items-center gap-1">
                <Button
                  aria-label="Previous day"
                  className="size-10"
                  disabled={!canGoPrevious}
                  size="icon"
                  title="Previous day"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (canGoPrevious) {
                      void navigateToDate(previousDate)
                    }
                  }}
                >
                  <ChevronLeftIcon className="size-4" />
                </Button>
                <div className="relative">
                  <CalendarIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="station-date"
                    className="h-10 w-36 pl-9"
                    aria-label="Observation date in YYYY-MM-DD format"
                    inputMode="numeric"
                    maxLength={10}
                    pattern="\d{4}-\d{2}-\d{2}"
                    placeholder="YYYY-MM-DD"
                    title="Use YYYY-MM-DD"
                    type="text"
                    value={dateInput}
                    onBlur={commitDateInput}
                    onChange={(event) => updateDateInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur()
                      }
                    }}
                  />
                </div>
                <Button
                  aria-label="Next day"
                  className="size-10"
                  disabled={!canGoNext}
                  size="icon"
                  title="Next day"
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (canGoNext) {
                      void navigateToDate(nextDate)
                    }
                  }}
                >
                  <ChevronRightIcon className="size-4" />
                </Button>
              </div>
            </div>
          </div>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          <TemperatureStat
            label={`Highest temperature on ${temperatureStatDate}`}
            value={formatTemperature(data.highTempC, unit, data.highTempF)}
          />
          <TemperatureStat
            label={`Lowest temperature on ${temperatureStatDate}`}
            value={formatTemperature(data.lowTempC, unit, data.lowTempF)}
          />
        </section>

        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-normal">
                Temperature
              </h2>
              <p className="text-sm text-muted-foreground">{data.localDate}</p>
            </div>
            <ToggleGroup
              type="single"
              value={unit}
              variant="outline"
              onValueChange={(value) => {
                if (value === "c" || value === "f") {
                  setUnit(value)
                }
              }}
            >
              <ToggleGroupItem value="c">°C</ToggleGroupItem>
              <ToggleGroupItem value="f">°F</ToggleGroupItem>
            </ToggleGroup>
          </div>
          <TemperatureChart points={data.chartPoints} unit={unit} />
        </section>

        <section className="space-y-4">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold tracking-normal">
                Observations
              </h2>
              <p className="text-sm text-muted-foreground">
                {data.observations.length} displayed observation
                {data.observations.length === 1 ? "" : "s"}
              </p>
            </div>
            {data.dayCoverage.status === "current" &&
            data.ingestStatus?.finishedAt ? (
              <p
                className="text-sm text-muted-foreground"
                title={data.ingestStatus.finishedAt}
              >
                Last poll {formatLocalTime(data.ingestStatus.finishedAt)}
              </p>
            ) : (
              <HistoricalCoverageLabel status={data.dayCoverage.status} />
            )}
          </div>
          <ObservationsTable observations={data.observations} unit={unit} />
        </section>
      </div>
    </main>
  )
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  )
}

function isAllowedDate(value: string, minDate: string, maxDate: string) {
  return isIsoDate(value) && value >= minDate && value <= maxDate
}

function addIsoDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function formatLocalTime(value: string) {
  const date = new Date(value)

  if (!Number.isFinite(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

function TemperatureStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-5 py-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-normal">{value}</p>
    </div>
  )
}

function HistoricalCoverageLabel({
  status,
}: {
  status: "current" | "complete" | "incomplete"
}) {
  if (status === "current") {
    return null
  }

  if (status === "complete") {
    return <p className="text-sm text-muted-foreground">Data complete</p>
  }

  return <p className="text-sm text-muted-foreground">Data incomplete</p>
}

function PredictionMarketIconLink({
  href,
  label,
  children,
}: {
  href: string
  label: string
  children: React.ReactNode
}) {
  return (
    <a
      aria-label={label}
      className="inline-flex size-5 items-center justify-center rounded-sm transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
      href={href}
      rel="noreferrer"
      target="_blank"
      title={label}
    >
      {children}
    </a>
  )
}

function HomeLogoLink() {
  return (
    <Link
      aria-label="Weather METARs home"
      className="-ml-3 inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium tracking-normal text-foreground transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      to="/"
    >
      <img
        alt=""
        aria-hidden="true"
        className="size-5 shrink-0"
        src="/logo.svg"
      />
      <span>Weather METARs</span>
    </Link>
  )
}
