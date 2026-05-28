import { createFileRoute, Link } from "@tanstack/react-router"

import { StationSearch } from "@/components/station-search"

export const Route = createFileRoute("/")({ component: App })

function App() {
  return (
    <main className="min-h-svh bg-background px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100svh-2.5rem)] w-full max-w-7xl flex-col">
        <header className="-ml-3 flex h-8 items-center gap-1.5 px-2.5">
          <img
            alt=""
            aria-hidden="true"
            className="size-5 shrink-0"
            src="/logo.svg"
          />
          <span className="text-sm font-medium tracking-normal text-foreground">
            Weather METARs
          </span>
        </header>

        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-xl space-y-5">
            <h1 className="text-center text-3xl font-semibold tracking-normal text-balance sm:text-4xl">
              Find a station or city
            </h1>
            <div>
              <StationSearch autoFocus />
            </div>
          </div>
        </div>
        <footer className="space-y-3 pb-1 text-center">
          <p className="text-sm leading-6 text-muted-foreground">
            Open-source, auditable observations from public aviation weather
            sources.
          </p>
          <nav
            aria-label="Footer"
            className="flex justify-center gap-6 text-sm font-medium text-muted-foreground"
          >
            <Link className="transition-colors hover:text-foreground" to="/faq">
              FAQ
            </Link>
            <a
              className="transition-colors hover:text-foreground"
              href="https://github.com/jgoyvaerts/WeatherMETARs"
            >
              GitHub
            </a>
          </nav>
        </footer>
      </div>
    </main>
  )
}
