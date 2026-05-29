import { describe, expect, it } from "vitest"

import { planMetarDayReconcileWindows } from "./day-reconcile.server"

describe("planMetarDayReconcileWindows", () => {
  it("plans archive-ready hourly windows from yesterday through today", () => {
    const plan = planMetarDayReconcileWindows({
      now: new Date("2026-05-29T03:30:00.000Z"),
      lookbackDays: 1,
      archiveReadyDelayMs: 60 * 60 * 1000,
    })

    expect(plan.skippedNotReadyCount).toBe(0)
    expect(plan.windows).toHaveLength(26)
    expect(plan.windows[0]).toEqual({
      startDate: "2026-05-28T00:00:00Z",
      endDate: "2026-05-28T01:00:00Z",
    })
    expect(plan.windows.at(-1)).toEqual({
      startDate: "2026-05-29T01:00:00Z",
      endDate: "2026-05-29T02:00:00Z",
    })
  })

  it("keeps the previous UTC day in scope long enough to close it out", () => {
    const plan = planMetarDayReconcileWindows({
      now: new Date("2026-05-29T01:30:00.000Z"),
      lookbackDays: 1,
      archiveReadyDelayMs: 60 * 60 * 1000,
    })

    expect(plan.windows.at(-1)).toEqual({
      startDate: "2026-05-28T23:00:00Z",
      endDate: "2026-05-29T00:00:00Z",
    })
  })

  it("waits until at least one current-day archive hour is ready", () => {
    expect(
      planMetarDayReconcileWindows({
        now: new Date("2026-05-29T00:30:00.000Z"),
        lookbackDays: 0,
        archiveReadyDelayMs: 60 * 60 * 1000,
      })
    ).toEqual({
      windows: [],
      skippedNotReadyCount: 1,
    })
  })
})
