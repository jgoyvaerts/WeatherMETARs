import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

export const Route = createFileRoute("/faq")({ component: FaqRoute })

const deployedVersion = import.meta.env.VITE_COMMIT_HASH ?? "unknown"

function FaqRoute() {
  return (
    <main className="flex-1 bg-background px-6 py-8">
      <div className="mx-auto max-w-3xl space-y-10">
        <header className="space-y-6 border-b pb-8">
          <Button asChild className="-ml-3" variant="ghost">
            <Link to="/">
              <ArrowLeftIcon className="size-4" />
              Home
            </Link>
          </Button>
          <div className="space-y-3">
            <h1 className="text-4xl font-semibold tracking-normal sm:text-5xl">
              FAQ
            </h1>
          </div>
        </header>

        <section className="space-y-8">
          <FaqItem question="What's the goal of this website?">
            <p>
              Weather METARs is intended to provide an open-source, auditable
              alternative to Wunderground.com for METAR-based weather data.
              Wunderground has proven unreliable for this use case: it does not
              always use METAR as its source, its data sourcing is not
              transparent, and it has recently omitted METAR updates in ways
              that affected market outcomes. Prediction markets such as
              Polymarket, Interactive Brokers, and Robinhood use
              Wunderground.com as a resolution source, so data quality can
              affect significant amounts of capital. This project aims to
              provide a reliable alternative whose data and behavior can be
              trusted, inspected, and audited.
            </p>
          </FaqItem>

          <FaqItem question="Where does the data come from?">
            <p>
              Current observations and station metadata come from public NOAA
              Aviation Weather Center cache files. Weather METARs ingests the
              global current METAR CSV cache and the station metadata JSON
              cache, deduplicates observations, and stores the raw METAR text
              alongside parsed values.
            </p>
            <p>
              Historical data comes from Iowa Environmental Mesonet sources,
              primarily the raw SAO archive for broad backfills and the IEM ASOS
              endpoint for station or network-scoped backfills.
            </p>
            <p>
              The polling worker refreshes current METAR data every five
              minutes.
            </p>
            <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
              <li>
                NOAA METAR cache:{" "}
                <a
                  className="font-medium text-foreground underline underline-offset-4"
                  href="https://aviationweather.gov/data/cache/metars.cache.csv.gz"
                >
                  metars.cache.csv.gz
                </a>
              </li>
              <li>
                NOAA station cache:{" "}
                <a
                  className="font-medium text-foreground underline underline-offset-4"
                  href="https://aviationweather.gov/data/cache/stations.cache.json.gz"
                >
                  stations.cache.json.gz
                </a>
              </li>
              <li>
                IEM raw SAO archive:{" "}
                <a
                  className="font-medium text-foreground underline underline-offset-4"
                  href="https://mesonet-longterm.agron.iastate.edu/archive/raw/sao/"
                >
                  mesonet-longterm.agron.iastate.edu/archive/raw/sao
                </a>
              </li>
              <li>
                IEM ASOS download endpoint:{" "}
                <a
                  className="font-medium text-foreground underline underline-offset-4"
                  href="https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py"
                >
                  request/asos.py
                </a>
              </li>
            </ul>
          </FaqItem>

          <FaqItem question="How can we trust this data?">
            <p>
              The project is fully open source, including the ingestion,
              parsing, storage, and display code. Anyone can inspect how the
              source data is collected and processed, run the project
              independently, and audit changes through the{" "}
              <a
                className="font-medium text-foreground underline underline-offset-4"
                href="https://github.com/jgoyvaerts/WeatherMETARs"
              >
                public repository
              </a>
              .
            </p>
          </FaqItem>
        </section>

        <p className="border-t pt-5 font-mono text-xs text-muted-foreground/70">
          Deployed version {deployedVersion}
        </p>
      </div>
    </main>
  )
}

function FaqItem({
  question,
  children,
}: {
  question: string
  children: React.ReactNode
}) {
  return (
    <article className="space-y-3 border-b pb-8 last:border-b-0 last:pb-0">
      <h2 className="text-xl font-semibold tracking-normal">{question}</h2>
      <div className="space-y-4 leading-7 text-muted-foreground">
        {children}
      </div>
    </article>
  )
}
