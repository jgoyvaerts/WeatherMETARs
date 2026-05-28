import { cn } from "@/lib/utils"

type RobinhoodIconProps = {
  className?: string
}

export function RobinhoodIcon({ className }: RobinhoodIconProps) {
  return (
    <img
      alt="Robinhood"
      className={cn("h-4 w-3.5 shrink-0 object-contain", className)}
      src="/robinhood-icon-green.svg"
      title="Used by Robinhood"
    />
  )
}
