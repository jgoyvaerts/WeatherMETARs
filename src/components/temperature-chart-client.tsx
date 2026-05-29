import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import type { ChartConfig } from "@/components/ui/chart"
import { temperatureValue } from "@/lib/weather/units"
import type { TemperaturePoint, TemperatureUnit } from "@/lib/weather/types"

type TemperatureChartClientProps = {
  points: TemperaturePoint[]
  unit: TemperatureUnit
}

const chartConfig = {
  temperature: {
    label: "Temperature",
    color: "var(--chart-temperature)",
  },
} satisfies ChartConfig

export function TemperatureChartClient({
  points,
  unit,
}: TemperatureChartClientProps) {
  const unitLabel = unit === "c" ? "°C" : "°F"
  const data = points.map((point) => ({
    ...point,
    temperature: temperatureValue(point.tempC, unit, point.tempF),
  }))

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
          dataKey="localTimeLabel"
          interval="preserveStartEnd"
          minTickGap={28}
          tickLine={false}
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
              formatter={(value) => [`${value} ${unitLabel}`, "Temperature"]}
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
