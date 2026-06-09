import { Hono } from "hono"
import { cors } from "hono/cors"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { logger } from "hono/logger"
import { proxy } from "hono/proxy"

const app = new Hono()

app.use(cors())

app.use(logger())

app.use(async (c, next) => {
  await next()
  c.res.headers.set("X-Accel-Buffering", "no")
})

app.get("/", (c) => c.text("A proxy for AI!"))

const fetchWithTimeout = async (
  url: string,
  { timeout, ...options }: RequestInit & { timeout: number },
) => {
  const controller = new AbortController()

  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeout)

  try {
    const res = await proxy(url, {
      ...options,
      signal: controller.signal,
      // pass redirects through to the client instead of following them
      // (following crashes undici on streamed request bodies and breaks
      // signed-URL redirects from media providers)
      redirect: "manual",
      // @ts-expect-error
      duplex: "half",
    })
    clearTimeout(timeoutId)
    return res
  } catch (error) {
    clearTimeout(timeoutId)
    if (controller.signal.aborted) {
      return new Response("Request timeout", {
        status: 504,
      })
    }

    // any non-abort failure here means the upstream couldn't be reached
    console.error(`failed to reach ${url}:`, error)
    return new Response("Bad Gateway", {
      status: 502,
    })
  }
}

const DEFAULT_TIMEOUT = 60000

export const isForwardableHeader = (name: string) => {
  const k = name.toLowerCase()
  return (
    !k.startsWith("cf-") &&
    !k.startsWith("x-forwarded-") &&
    !k.startsWith("cdn-") &&
    k !== "x-real-ip" &&
    k !== "host"
  )
}

export const proxies: {
  pathSegment: string
  target: string
  orHostname?: string
  // for upstreams that hold the connection open until generation completes
  timeout?: number
}[] = [
  {
    pathSegment: "generativelanguage",
    orHostname: "gooai.chatkit.app",
    target: "https://generativelanguage.googleapis.com",
  },
  {
    pathSegment: "groq",
    target: "https://api.groq.com",
  },
  {
    pathSegment: "anthropic",
    target: "https://api.anthropic.com",
  },
  {
    pathSegment: "pplx",
    target: "https://api.perplexity.ai",
  },
  {
    pathSegment: "openai",
    target: "https://api.openai.com",
  },
  {
    pathSegment: "mistral",
    target: "https://api.mistral.ai",
  },
  {
    pathSegment: "openrouter/api",
    target: "https://openrouter.ai/api",
  },
  {
    pathSegment: "openrouter",
    target: "https://openrouter.ai/api",
  },
  {
    pathSegment: "xai",
    target: "https://api.x.ai",
  },
  {
    pathSegment: "cerebras",
    target: "https://api.cerebras.ai",
  },
  {
    pathSegment: "googleapis-cloudcode-pa",
    target: "https://cloudcode-pa.googleapis.com",
  },
  {
    pathSegment: "fal",
    target: "https://fal.run",
    timeout: 600000,
  },
  {
    pathSegment: "fal-queue",
    target: "https://queue.fal.run",
  },
  {
    pathSegment: "fal-api",
    target: "https://api.fal.ai",
  },
  {
    pathSegment: "fal-rest",
    target: "https://rest.fal.ai",
  },
  {
    pathSegment: "fal-media",
    target: "https://v3.fal.media",
  },
  {
    pathSegment: "fal-ws",
    target: "https://ws.fal.run",
  },
  {
    pathSegment: "kling",
    target: "https://api-singapore.klingai.com",
  },
  {
    pathSegment: "kling-cn",
    target: "https://api-beijing.klingai.com",
  },
  {
    pathSegment: "bfl",
    target: "https://api.bfl.ai",
  },
  {
    pathSegment: "bfl-eu",
    target: "https://api.eu.bfl.ai",
  },
  {
    pathSegment: "bfl-us",
    target: "https://api.us.bfl.ai",
  },
  {
    pathSegment: "elevenlabs",
    target: "https://api.elevenlabs.io",
    timeout: 300000,
  },
  {
    pathSegment: "elevenlabs-eu",
    target: "https://api.eu.residency.elevenlabs.io",
    timeout: 300000,
  },
  {
    pathSegment: "elevenlabs-in",
    target: "https://api.in.residency.elevenlabs.io",
    timeout: 300000,
  },
]

app.post(
  "/custom-model-proxy",
  zValidator(
    "query",
    z.object({
      url: z.string().url(),
    }),
  ),
  async (c) => {
    const { url } = c.req.valid("query")

    const res = await proxy(url, {
      method: c.req.method,
      body: c.req.raw.body,
      headers: c.req.raw.headers,
    })

    return new Response(res.body, {
      headers: res.headers,
      status: res.status,
    })
  },
)

app.use(async (c, next) => {
  const url = new URL(c.req.url)

  const proxy = proxies.find(
    (p) =>
      url.pathname.startsWith(`/${p.pathSegment}/`) ||
      (p.orHostname && url.hostname === p.orHostname),
  )

  if (proxy) {
    const headers = new Headers()
    headers.set("host", new URL(proxy.target).hostname)

    c.req.raw.headers.forEach((value, key) => {
      if (isForwardableHeader(key)) {
        headers.set(key, value)
      }
    })

    const targetUrl = `${proxy.target}${url.pathname.replace(
      `/${proxy.pathSegment}/`,
      "/",
    )}${url.search}`

    const res = await fetchWithTimeout(targetUrl, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      timeout: proxy.timeout ?? DEFAULT_TIMEOUT,
    })

    return new Response(res.body, {
      headers: res.headers,
      status: res.status,
    })
  }

  next()
})

export default app
