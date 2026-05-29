import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table"
import type { ColumnDef, SortingState } from "@tanstack/react-table"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { PublicObservationRow } from "@/lib/weather/station-day-public"
import { formatTemperature } from "@/lib/weather/units"
import type { TemperatureUnit } from "@/lib/weather/types"

type ObservationsTableProps = {
  observations: PublicObservationRow[]
  unit: TemperatureUnit
}

const fixedObservationColumns = [
  { key: "observedAtUtc", className: "w-28" },
  { key: "tempC", className: "w-24" },
  { key: "dewpointC", className: "w-28" },
] as const

export function ObservationsTable({
  observations,
  unit,
}: ObservationsTableProps) {
  const [sorting, setSorting] = React.useState<SortingState>([
    { id: "observedAtUtc", desc: false },
  ])
  const columns = React.useMemo<ColumnDef<PublicObservationRow>[]>(
    () => [
      {
        accessorKey: "observedAtUtc",
        header: "Local time",
        cell: ({ row }) => row.original.localTimeLabel,
      },
      {
        accessorKey: "tempC",
        header: "Temp",
        cell: ({ row }) =>
          formatTemperature(row.original.tempC, unit, row.original.tempF),
      },
      {
        accessorKey: "dewpointC",
        header: "Dewpoint",
        cell: ({ row }) =>
          formatTemperature(
            row.original.dewpointC,
            unit,
            row.original.dewpointF
          ),
      },
      {
        accessorKey: "rawText",
        header: "Raw METAR",
        cell: ({ row }) => (
          <span className="block min-w-96 font-mono text-xs leading-relaxed whitespace-normal">
            {row.original.rawText}
          </span>
        ),
      },
    ],
    [unit]
  )

  const table = useReactTable({
    data: observations,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  if (observations.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        No stored METAR observations for this local day
      </div>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table className="min-w-[44rem] table-fixed">
        <colgroup>
          {fixedObservationColumns.map((column) => (
            <col className={column.className} key={column.key} />
          ))}
          <col />
        </colgroup>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell className="align-top" key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
