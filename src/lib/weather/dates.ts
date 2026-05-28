import { formatInTimeZone, fromZonedTime } from "date-fns-tz"
import tzLookup from "tz-lookup"

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function timezoneForLocation(lat: number | null, lon: number | null) {
  if (lat === null || lon === null) {
    return "UTC"
  }

  try {
    return tzLookup(lat, lon)
  } catch {
    return "UTC"
  }
}

export function localDateForUtc(utcIso: string, timezone: string) {
  return formatInTimeZone(new Date(utcIso), timezone, "yyyy-MM-dd")
}

export function localTimestampForUtc(utcIso: string, timezone: string) {
  return formatInTimeZone(new Date(utcIso), timezone, "yyyy-MM-dd HH:mm")
}

export function localTimeForUtc(utcIso: string, timezone: string) {
  return formatInTimeZone(new Date(utcIso), timezone, "HH:mm")
}

export function currentLocalDate(timezone: string) {
  return formatInTimeZone(new Date(), timezone, "yyyy-MM-dd")
}

export function normalizeDateParam(date: string | undefined, timezone: string) {
  if (date && DATE_PATTERN.test(date)) {
    return date
  }

  return currentLocalDate(timezone)
}

export function utcRangeForLocalDate(localDate: string, timezone: string) {
  const nextDate = new Date(`${localDate}T00:00:00.000Z`)
  nextDate.setUTCDate(nextDate.getUTCDate() + 1)

  return {
    startUtc: fromZonedTime(`${localDate}T00:00:00`, timezone).toISOString(),
    endUtc: fromZonedTime(
      `${nextDate.toISOString().slice(0, 10)}T00:00:00`,
      timezone
    ).toISOString(),
  }
}
