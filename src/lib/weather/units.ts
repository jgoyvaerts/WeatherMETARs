export function cToF(value: number) {
  return (value * 9) / 5 + 32
}

export function roundFahrenheitFromC(valueC: number) {
  return Math.round(cToF(valueC))
}

export function formatTemperature(
  valueC: number | null,
  unit: "c" | "f",
  valueF?: number | null
) {
  if (!isFiniteNumber(valueC)) {
    return "N/A"
  }

  const value = temperatureValue(valueC, unit, valueF)
  const rounded = Number(value.toFixed(1))
  const text = Number.isInteger(rounded)
    ? rounded.toFixed(0)
    : rounded.toFixed(1)
  return `${text} °${unit.toUpperCase()}`
}

export function temperatureValue(
  valueC: number,
  unit: "c" | "f",
  valueF?: number | null
) {
  if (unit === "f") {
    return isFiniteNumber(valueF) ? valueF : roundFahrenheitFromC(valueC)
  }

  return valueC
}

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value)
}
