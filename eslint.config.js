//  @ts-check

import { tanstackConfig } from "@tanstack/eslint-config"

export default [
  ...tanstackConfig,
  {
    rules: {
      "import/no-cycle": "off",
      "import/order": "off",
      "sort-imports": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/require-await": "off",
      "pnpm/json-enforce-catalog": "off",
    },
  },
  {
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "import/consistent-type-specifier-style": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "no-shadow": "off",
    },
  },
  {
    ignores: [
      "eslint.config.js",
      ".prettierrc",
      ".tanstack/**",
      ".vinxi/**",
      ".wrangler/**",
      ".output/**",
      "data/**",
      "dist/**",
      "dist-ssr/**",
      "node_modules/**",
      "src/routeTree.gen.ts",
    ],
  },
]
