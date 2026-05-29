import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import type { PublicTemperaturePoint } from "@/lib/weather/station-day-public"
import { temperatureValue } from "@/lib/weather/units"
import type { TemperatureUnit } from "@/lib/weather/types"

type TemperatureChartClientProps = {
  points: PublicTemperaturePoint[]
  unit: TemperatureUnit
}

const chartConfig = {
  temperature: {
    label: "Temperature",
    color: "var(--chart-temperature)",
  },
} satisfies ChartConfig

const DAY_START_MINUTE = 0
const DAY_END_MINUTE = 23 * 60 + 59
const DAY_TICKS = [0, 6 * 60, 12 * 60, 18 * 60, DAY_END_MINUTE]

export function TemperatureChartClient({
  points,
  unit,
}: TemperatureChartClientProps) {
  const unitLabel = unit === "c" ? "°C" : "°F"
  const data = points
    .flatMap((point) => {
      const localMinute = localMinuteFromLabel(point.localTimeLabel)

      if (localMinute === null) {
        return []
      }

      return {
        ...point,
        localMinute,
        temperature: temperatureValue(point.tempC, unit, point.tempF),
      }
    })
    .sort((left, right) => left.localMinute - right.localMinute)

  return (
    <ChartContainer className="h-72 w-full" config={chartConfig}>
      <LineChart
        accessibilityLayer
        data={data}
        margin={{ left: 8, right: 18, top: 16, bottom: 8 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="localMinute"
          domain={[DAY_START_MINUTE, DAY_END_MINUTE]}
          ticks={DAY_TICKS}
          tickFormatter={formatMinuteLabel}
          minTickGap={28}
          tickLine={false}
          type="number"
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          tickMargin={8}
          unit={` ${unitLabel}`}
          width={48}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => (
                <span className="font-mono font-medium text-foreground tabular-nums">
                  {value} {unitLabel}
                </span>
              )}
              labelFormatter={(_, payload) =>
                payload[0]?.payload?.localTimeLabel ?? ""
              }
            />
          }
        />
        <Line
          dataKey="temperature"
          dot={false}
          isAnimationActive={false}
          stroke="var(--color-temperature)"
          strokeWidth={2}
          type="linear"
        />
      </LineChart>
    </ChartContainer>
  )
}

function localMinuteFromLabel(label: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(label)

  if (!match) {
    return null
  }

  const hours = Number(match[1])
  const minutes = Number(match[2])

  if (hours > 23 || minutes > 59) {
    return null
  }

  return hours * 60 + minutes
}

function formatMinuteLabel(value: number | string) {
  const minuteOfDay = Number(value)

  if (!Number.isFinite(minuteOfDay)) {
    return String(value)
  }

  const hours = Math.floor(minuteOfDay / 60)
  const minutes = minuteOfDay % 60

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}
