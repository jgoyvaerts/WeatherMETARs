import * as React from "react"

import type { TemperaturePoint, TemperatureUnit } from "@/lib/weather/types"

type TemperatureChartProps = {
  points: TemperaturePoint[]
  unit: TemperatureUnit
}

const TemperatureChartClient = React.lazy(() =>
  import("./temperature-chart-client").then((module) => ({
    default: module.TemperatureChartClient,
  }))
)

export function TemperatureChart({ points, unit }: TemperatureChartProps) {
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
  }, [])

  if (points.length === 0) {
    return <EmptyTemperatureChart />
  }

  if (!mounted) {
    return <TemperatureChartPlaceholder />
  }

  return (
    <React.Suspense fallback={<TemperatureChartPlaceholder />}>
      <TemperatureChartClient points={points} unit={unit} />
    </React.Suspense>
  )
}

function TemperatureChartPlaceholder() {
  return (
    <div
      aria-hidden="true"
      className="h-72 w-full rounded-lg border border-dashed bg-muted/20"
    />
  )
}

function EmptyTemperatureChart() {
  return (
    <div className="flex h-64 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
      No temperature observations stored for this day
    </div>
  )
}
