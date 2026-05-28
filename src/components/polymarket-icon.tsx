import { cn } from "@/lib/utils"

type PolymarketIconProps = {
  className?: string
}

export function PolymarketIcon({ className }: PolymarketIconProps) {
  return (
    <img
      alt="Polymarket"
      className={cn("size-4 shrink-0 rounded-[2px]", className)}
      src="/polymarket-icon-blue.svg"
      title="Used by Polymarket"
    />
  )
}
