import * as React from "react"
import { useNavigate } from "@tanstack/react-router"
import { Loader2Icon, SearchIcon } from "lucide-react"

import { InteractiveBrokersIcon } from "@/components/interactive-brokers-icon"
import { PolymarketIcon } from "@/components/polymarket-icon"
import { RobinhoodIcon } from "@/components/robinhood-icon"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { searchStations } from "@/lib/weather/weather.functions"
import type { StationSummary } from "@/lib/weather/types"

type StationSearchProps = {
  autoFocus?: boolean
  compact?: boolean
}

type SearchStatus = "idle" | "searching" | "settled"

export function StationSearch({
  autoFocus = false,
  compact = false,
}: StationSearchProps) {
  const navigate = useNavigate()
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<StationSummary[]>([])
  const [searchStatus, setSearchStatus] = React.useState<SearchStatus>("idle")
  const [searchedQuery, setSearchedQuery] = React.useState("")
  const [activeResultIndex, setActiveResultIndex] = React.useState(-1)
  const [submitted, setSubmitted] = React.useState(false)
  const resultListId = React.useId()
  const trimmedQuery = query.trim()
  const hasSearchQuery = trimmedQuery.length >= 2
  const hasSettledResults =
    searchStatus === "settled" && searchedQuery === trimmedQuery
  const isSearching = hasSearchQuery && !hasSettledResults
  const showNoMatch = hasSettledResults && results.length === 0
  const activeStation =
    hasSettledResults && activeResultIndex >= 0
      ? results[activeResultIndex]
      : undefined

  React.useEffect(() => {
    const trimmed = query.trim()
    let cancelled = false

    if (trimmed.length < 2) {
      setResults([])
      setSearchedQuery("")
      setSearchStatus("idle")
      setActiveResultIndex(-1)
      return
    }

    setSearchStatus("searching")
    const timeout = window.setTimeout(() => {
      searchStations({ data: { query: trimmed, limit: 4 } })
        .then((stations) => {
          if (!cancelled) {
            setResults(stations)
            setSearchedQuery(trimmed)
            setSearchStatus("settled")
            setActiveResultIndex(stations.length > 0 ? 0 : -1)
          }
        })
        .catch(() => {
          if (!cancelled) {
            setResults([])
            setSearchedQuery(trimmed)
            setSearchStatus("settled")
            setActiveResultIndex(-1)
          }
        })
    }, 160)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [query])

  async function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = query.trim()

    if (!trimmed) {
      return
    }

    setSubmitted(true)
    if (activeStation) {
      await selectStation(activeStation.stationCode)
      return
    }

    const stations =
      hasSettledResults && results.length > 0
        ? results
        : await searchStations({ data: { query: trimmed, limit: 1 } })
    const stationCode = stations[0]?.stationCode ?? trimmed.toUpperCase()

    resetSearch()
    await navigate({
      to: "/stations/$stationCode",
      params: { stationCode },
      search: { date: undefined },
    })
  }

  function handleSearchKeyDown(event: React.KeyboardEvent) {
    if (!hasSettledResults || results.length === 0) {
      return
    }

    if (event.key === "ArrowDown") {
      event.preventDefault()
      setActiveResultIndex((index) =>
        index < 0 ? 0 : (index + 1) % results.length
      )
    }

    if (event.key === "ArrowUp") {
      event.preventDefault()
      setActiveResultIndex((index) =>
        index <= 0 ? results.length - 1 : index - 1
      )
    }
  }

  async function selectStation(stationCode: string) {
    resetSearch()
    await navigate({
      to: "/stations/$stationCode",
      params: { stationCode },
      search: { date: undefined },
    })
  }

  function resetSearch() {
    setQuery("")
    setResults([])
    setSearchStatus("idle")
    setSearchedQuery("")
    setActiveResultIndex(-1)
    setSubmitted(false)
  }

  return (
    <div className={compact ? "w-full max-w-xl" : "w-full"}>
      <div className="relative">
        <form
          className="flex gap-2"
          onKeyDown={handleSearchKeyDown}
          onSubmit={submitSearch}
        >
          <div className="relative min-w-0 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-activedescendant={
                activeStation
                  ? `${resultListId}-${activeStation.stationCode}`
                  : undefined
              }
              aria-autocomplete="list"
              aria-controls={hasSearchQuery ? resultListId : undefined}
              aria-expanded={hasSearchQuery}
              autoFocus={autoFocus}
              className="h-12 pl-10 text-base"
              role="combobox"
              value={query}
              placeholder="Tokyo, London, KLAX, etc."
              onChange={(event) => {
                setSubmitted(false)
                setQuery(event.target.value)
              }}
            />
          </div>
          <Button
            className="h-12 w-24 px-5"
            type="submit"
            disabled={submitted && isSearching}
          >
            {isSearching ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              "Search"
            )}
          </Button>
        </form>

        {hasSearchQuery ? (
          <div
            className="absolute top-full right-0 left-0 z-50 mt-3 overflow-hidden rounded-lg border bg-background shadow-lg"
            id={resultListId}
            role="listbox"
          >
            {isSearching ? (
              <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" />
                Searching
              </div>
            ) : hasSettledResults && results.length > 0 ? (
              <div className="divide-y">
                {results.map((station, index) => (
                  <button
                    aria-selected={index === activeResultIndex}
                    className={cn(
                      "flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors focus:bg-accent focus:outline-none",
                      index === activeResultIndex && "bg-accent"
                    )}
                    id={`${resultListId}-${station.stationCode}`}
                    key={station.stationCode}
                    role="option"
                    type="button"
                    onClick={() => void selectStation(station.stationCode)}
                    onMouseMove={() => setActiveResultIndex(index)}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {station.stationCode}
                        </span>
                        {station.country ? (
                          <Badge variant="secondary">{station.country}</Badge>
                        ) : null}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {[station.name, station.state]
                          .filter(Boolean)
                          .join(", ")}
                      </div>
                    </div>
                    <span className="flex shrink-0 items-center gap-1.5 text-sm text-sky-700">
                      {station.usedByPolymarket ? <PolymarketIcon /> : null}
                      {station.usedByInteractiveBrokers ? (
                        <InteractiveBrokersIcon />
                      ) : null}
                      {station.usedByRobinhood ? <RobinhoodIcon /> : null}
                      {station.timezone}
                    </span>
                  </button>
                ))}
              </div>
            ) : showNoMatch ? (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                No stored station match
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
