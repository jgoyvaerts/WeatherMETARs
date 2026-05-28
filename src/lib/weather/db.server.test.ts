import { describe, expect, it } from "vitest"

import { isSqliteBusyError, retrySqliteBusy } from "./db.server"

describe("retrySqliteBusy", () => {
  it("retries transient SQLite busy errors", async () => {
    let attempts = 0
    const retryAttempts: number[] = []

    const result = await retrySqliteBusy(
      () => {
        attempts += 1

        if (attempts < 3) {
          throw sqliteError("SQLITE_BUSY", "database is locked")
        }

        return "ok"
      },
      {
        maxRetries: 3,
        retryBaseMs: 0,
        retryMaxMs: 0,
        onRetry: ({ attempt }) => retryAttempts.push(attempt),
      }
    )

    expect(result).toBe("ok")
    expect(attempts).toBe(3)
    expect(retryAttempts).toEqual([1, 2])
  })

  it("does not retry non-lock errors", async () => {
    let attempts = 0

    await expect(
      retrySqliteBusy(
        () => {
          attempts += 1
          throw sqliteError("SQLITE_CONSTRAINT", "unique constraint failed")
        },
        { maxRetries: 3, retryBaseMs: 0, retryMaxMs: 0 }
      )
    ).rejects.toThrow("unique constraint failed")
    expect(attempts).toBe(1)
  })
})

describe("isSqliteBusyError", () => {
  it("detects busy and locked SQLite errors", () => {
    expect(isSqliteBusyError(sqliteError("SQLITE_BUSY", "busy"))).toBe(true)
    expect(isSqliteBusyError(sqliteError("SQLITE_LOCKED", "locked"))).toBe(true)
    expect(isSqliteBusyError(new Error("database is locked"))).toBe(true)
    expect(isSqliteBusyError(new Error("other failure"))).toBe(false)
  })
})

function sqliteError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}
