import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start"

const BROWSER_CACHE_CONTROL = "public, max-age=0, must-revalidate"
const CDN_CACHE_CONTROL = "public, max-age=300, stale-while-revalidate=60"

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
})

const publicCacheMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const result = await next()
    const { response } = result

    if (isPublicCacheableResponse(request, response)) {
      response.headers.set("Cache-Control", BROWSER_CACHE_CONTROL)
      response.headers.set("CDN-Cache-Control", CDN_CACHE_CONTROL)
      response.headers.set("Cloudflare-CDN-Cache-Control", CDN_CACHE_CONTROL)
    }

    return result
  }
)

function isPublicCacheableResponse(request: Request, response: Response) {
  const method = request.method.toUpperCase()

  if (method !== "GET" && method !== "HEAD") {
    return false
  }

  if (response.status !== 200) {
    return false
  }

  if (request.headers.has("Authorization")) {
    return false
  }

  if (response.headers.has("Set-Cookie")) {
    return false
  }

  return !response.headers.has("Cache-Control")
}

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, publicCacheMiddleware],
}))
