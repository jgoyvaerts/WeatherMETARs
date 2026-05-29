import { createFileRoute } from "@tanstack/react-router"

import { StationSearch } from "@/components/station-search"

export const Route = createFileRoute("/")({ component: App })

function App() {
  return (
    <main className="flex flex-1 bg-background px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col">
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
      </div>
    </main>
  )
}
