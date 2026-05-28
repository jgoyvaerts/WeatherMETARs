import { createServerFn } from "@tanstack/react-start"

type SearchStationsInput = {
  query: string
  limit?: number
}

type StationDayInput = {
  stationCode: string
  date?: string
}

export const searchStations = createServerFn({ method: "GET" })
  .inputValidator((data: SearchStationsInput) => ({
    query: data.query,
    limit: data.limit,
  }))
  .handler(async ({ data }) => {
    const { searchStationsInDb } = await import("./weather.server")
    return searchStationsInDb(data.query, data.limit)
  })

export const getStationDay = createServerFn({ method: "GET" })
  .inputValidator((data: StationDayInput) => ({
    stationCode: data.stationCode,
    date: data.date,
  }))
  .handler(async ({ data }) => {
    const { getStationDayFromDb } = await import("./weather.server")
    return getStationDayFromDb(data.stationCode, data.date)
  })
