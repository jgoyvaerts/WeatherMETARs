import { describe, expect, it } from "vitest"

import { formatTemperature, temperatureValue } from "./units"

describe("temperature unit formatting", () => {
  it("formats Fahrenheit as whole degrees", () => {
    expect(formatTemperature(31, "f")).toBe("88 °F")
    expect(formatTemperature(31, "f", 87)).toBe("87 °F")
  })

  it("uses supplied Fahrenheit values for chart data", () => {
    expect(temperatureValue(31, "f", 87)).toBe(87)
    expect(temperatureValue(31, "c", 87)).toBe(31)
  })
})
