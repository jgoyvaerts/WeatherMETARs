import { createFileRoute } from "@tanstack/react-router"

const BROWSER_CACHE_CONTROL = "public, max-age=0, must-revalidate"
const CDN_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=60"

export const Route = createFileRoute("/api/stations/$stationCode/day")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const [{ toPublicStationDayResponse }, { getStationDayFromDb }] =
          await Promise.all([
            import("@/lib/weather/station-day-public"),
            import("@/lib/weather/weather.server"),
          ])
        const url = new URL(request.url)
        const date = url.searchParams.get("date") ?? undefined

        return Response.json(
          toPublicStationDayResponse(
            getStationDayFromDb(params.stationCode, date)
          ),
          {
            headers: {
              "Cache-Control": BROWSER_CACHE_CONTROL,
              "CDN-Cache-Control": CDN_CACHE_CONTROL,
              "Cloudflare-CDN-Cache-Control": CDN_CACHE_CONTROL,
            },
          }
        )
      },
    },
  },
})
