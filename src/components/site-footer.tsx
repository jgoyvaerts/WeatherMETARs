import { Link } from "@tanstack/react-router"

const githubUrl = "https://github.com/jgoyvaerts/WeatherMETARs"

export function SiteFooter() {
  return (
    <footer className="border-t bg-background px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 text-center sm:flex-row sm:text-left">
        <p className="text-sm leading-6 text-muted-foreground">
          Open-source, auditable observations from public aviation weather
          sources.
        </p>
        <nav
          aria-label="Footer"
          className="flex shrink-0 items-center gap-6 text-sm font-medium text-muted-foreground"
        >
          <Link className="transition-colors hover:text-foreground" to="/faq">
            FAQ
          </Link>
          <a
            className="transition-colors hover:text-foreground"
            href={githubUrl}
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  )
}
