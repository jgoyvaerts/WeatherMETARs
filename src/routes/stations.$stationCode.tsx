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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { PublicStationDayResponse } from "@/lib/weather/station-day-public"
import { formatTemperature } from "@/lib/weather/units"
import type { TemperatureUnit } from "@/lib/weather/types"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/stations/$stationCode")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" ? search.date : undefined,
  }),
  loaderDeps: ({ search }) => ({
    date: search.date,
  }),
  loader: ({ params, deps }) => loadStationDay(params.stationCode, deps.date),
  component: StationRoute,
})

async function loadStationDay(
  stationCode: string,
  date: string | undefined
): Promise<PublicStationDayResponse> {
  if (import.meta.env.SSR) {
    const [{ toPublicStationDayResponse }, { getStationDayFromDb }] =
      await Promise.all([
        import("@/lib/weather/station-day-public"),
        import("@/lib/weather/weather.server"),
      ])
    return toPublicStationDayResponse(getStationDayFromDb(stationCode, date))
  }

  const response = await fetch(stationDayApiPath(stationCode, date), {
    headers: { Accept: "application/json" },
  })

  if (!response.ok) {
    throw new Error(`Failed to load station day: ${response.status}`)
  }

  return (await response.json()) as PublicStationDayResponse
}

function stationDayApiPath(stationCode: string, date: string | undefined) {
  const path = `/api/stations/${encodeURIComponent(stationCode)}/day`

  if (!date) {
    return path
  }

  return `${path}?${new URLSearchParams({ date })}`
}

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

  function selectDate(date: string) {
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
                <StationDatePicker
                  inputValue={dateInput}
                  maxDate={data.dateNavigation.maxDate}
                  minDate={data.dateNavigation.minDate}
                  selectedDate={data.localDate}
                  onBlur={commitDateInput}
                  onInputChange={updateDateInput}
                  onSelectDate={selectDate}
                />
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
              <LastPollTime value={data.ingestStatus.finishedAt} />
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

function StationDatePicker({
  inputValue,
  selectedDate,
  minDate,
  maxDate,
  onBlur,
  onInputChange,
  onSelectDate,
}: {
  inputValue: string
  selectedDate: string
  minDate: string
  maxDate: string
  onBlur: () => void
  onInputChange: (value: string) => void
  onSelectDate: (value: string) => void
}) {
  const selectedMonth = React.useMemo(
    () => startOfIsoMonth(selectedDate),
    [selectedDate]
  )
  const [open, setOpen] = React.useState(false)
  const [displayMonth, setDisplayMonth] = React.useState(selectedMonth)
  const days = React.useMemo(
    () => calendarDaysForMonth(displayMonth),
    [displayMonth]
  )
  const previousMonth = addIsoMonths(displayMonth, -1)
  const nextMonth = addIsoMonths(displayMonth, 1)
  const canGoPreviousMonth = monthEndIsoDate(previousMonth) >= minDate
  const canGoNextMonth = monthStartIsoDate(nextMonth) <= maxDate

  React.useEffect(() => {
    if (!open) {
      setDisplayMonth(selectedMonth)
    }
  }, [open, selectedMonth])

  function updateOpen(nextOpen: boolean) {
    if (nextOpen) {
      setDisplayMonth(selectedMonth)
    }

    setOpen(nextOpen)
  }

  function selectCalendarDate(date: string) {
    if (!isAllowedDate(date, minDate, maxDate)) {
      return
    }

    onSelectDate(date)
    setOpen(false)
  }

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={updateOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-label="Choose observation date"
            className="h-10 w-10 rounded-r-none"
            size="icon"
            title="Choose observation date"
            type="button"
            variant="outline"
          >
            <CalendarIcon className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Button
                aria-label="Previous month"
                className="size-8"
                disabled={!canGoPreviousMonth}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() => setDisplayMonth(previousMonth)}
              >
                <ChevronLeftIcon className="size-4" />
              </Button>
              <div
                aria-live="polite"
                className="text-sm font-medium text-foreground"
              >
                {formatMonthLabel(displayMonth)}
              </div>
              <Button
                aria-label="Next month"
                className="size-8"
                disabled={!canGoNextMonth}
                size="icon"
                type="button"
                variant="ghost"
                onClick={() => setDisplayMonth(nextMonth)}
              >
                <ChevronRightIcon className="size-4" />
              </Button>
            </div>

            <div className="grid grid-cols-7 text-center text-xs font-medium text-muted-foreground">
              {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
                <div className="py-1" key={day}>
                  {day}
                </div>
              ))}
            </div>

            <div className="grid grid-cols-7 gap-1">
              {days.map((day) => {
                const date = formatIsoDate(day)
                const isSelected = date === selectedDate
                const isOutsideMonth =
                  monthStartIsoDate(day) !== monthStartIsoDate(displayMonth)
                const isDisabled = !isAllowedDate(date, minDate, maxDate)

                return (
                  <button
                    aria-pressed={isSelected}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-30",
                      isOutsideMonth && "text-muted-foreground/50",
                      isSelected &&
                        "bg-primary text-primary-foreground hover:bg-primary"
                    )}
                    disabled={isDisabled}
                    key={date}
                    type="button"
                    onClick={() => selectCalendarDate(date)}
                  >
                    {day.getUTCDate()}
                  </button>
                )
              })}
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <Input
        id="station-date"
        className="h-10 w-36 rounded-l-none border-l-0"
        aria-label="Observation date in YYYY-MM-DD format"
        inputMode="numeric"
        maxLength={10}
        pattern="\d{4}-\d{2}-\d{2}"
        placeholder="YYYY-MM-DD"
        title="Use YYYY-MM-DD"
        type="text"
        value={inputValue}
        onBlur={onBlur}
        onChange={(event) => onInputChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}

function addIsoDays(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function addIsoMonths(value: string, amount: number) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCMonth(date.getUTCMonth() + amount)
  date.setUTCDate(1)
  return formatIsoDate(date)
}

function startOfIsoMonth(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(1)
  return formatIsoDate(date)
}

function monthStartIsoDate(value: string | Date) {
  const date =
    typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : value
  return formatIsoDate(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
  )
}

function monthEndIsoDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`)
  return formatIsoDate(
    new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0))
  )
}

function calendarDaysForMonth(value: string) {
  const monthStart = new Date(`${value}T00:00:00.000Z`)
  const gridStart = new Date(monthStart)
  gridStart.setUTCDate(monthStart.getUTCDate() - monthStart.getUTCDay())

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart)
    date.setUTCDate(gridStart.getUTCDate() + index)
    return date
  })
}

function formatIsoDate(value: Date) {
  return value.toISOString().slice(0, 10)
}

function formatMonthLabel(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00.000Z`))
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

function LastPollTime({ value }: { value: string }) {
  const [localTime, setLocalTime] = React.useState<string | null>(null)

  React.useEffect(() => {
    setLocalTime(formatLocalTime(value))
  }, [value])

  return (
    <p className="text-sm text-muted-foreground" title={value}>
      Last poll <time dateTime={value}>{localTime ?? "..."}</time>
    </p>
  )
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
