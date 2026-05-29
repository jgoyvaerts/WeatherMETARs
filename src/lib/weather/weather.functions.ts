import { createServerFn } from "@tanstack/react-start"

type SearchStationsInput = {
  query: string
  limit?: number
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
