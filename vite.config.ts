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

const config = defineConfig(({ command }) => ({
  define: {
    "import.meta.env.VITE_COMMIT_HASH": JSON.stringify(gitCommitHash()),
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    devtools(),
    tailwindcss(),
    tanstackStart(),
    command === "build" && nitro({ preset: "bun" }),
    viteReact(),
  ],
}))

export default config
