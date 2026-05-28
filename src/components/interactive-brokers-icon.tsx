import { cn } from "@/lib/utils"

type InteractiveBrokersIconProps = {
  className?: string
}

export function InteractiveBrokersIcon({
  className,
}: InteractiveBrokersIconProps) {
  return (
    <img
      alt="Interactive Brokers"
      className={cn("size-4 shrink-0 object-contain", className)}
      src="/interactive-brokers-symbol-red.svg"
      title="Used by Interactive Brokers"
    />
  )
}
