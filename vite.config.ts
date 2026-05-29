import { execSync } from "node:child_process"

import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { nitro } from "nitro/vite"
import tailwindcss from "@tailwindcss/vite"

function gitCommitHash() {
  if (process.env.VITE_COMMIT_HASH) {
    return process.env.VITE_COMMIT_HASH.slice(0, 12)
  }

  try {
    return execSync("git rev-parse --short=12 HEAD", {
      encoding: "utf8",
    }).trim()
  } catch {
    return "unknown"
  }
}

const PUBLIC_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"

const publicAssetRouteRules = Object.fromEntries(
  [
    "/apple-touch-icon.png",
    "/favicon.ico",
    "/favicon.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/interactive-brokers-logo.svg",
    "/interactive-brokers-symbol-red.svg",
    "/logo.svg",
    "/manifest.json",
    "/polymarket-icon-blue.svg",
    "/robinhood-icon-green.svg",
  ].map((route) => [
    route,
    {
      headers: {
        "cache-control": PUBLIC_ASSET_CACHE_CONTROL,
      },
    },
  ])
)

const config = defineConfig(({ command }) => ({
  define: {
    "import.meta.env.VITE_COMMIT_HASH": JSON.stringify(gitCommitHash()),
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart(),
    command === "build" &&
      nitro({ preset: "bun", routeRules: publicAssetRouteRules }),
    viteReact(),
  ],
}))

export default config
