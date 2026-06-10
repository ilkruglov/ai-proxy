import { Hono } from "hono"
import { cors } from "hono/cors"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { logger } from "hono/logger"
import { proxy } from "hono/proxy"
import { bodyLimit } from "hono/body-limit"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

const app = new Hono()

app.use(cors())

app.use(
  logger((str) => {
    // hono's logger prints the path including the query string — strip
    // it so client credentials passed as query params (e.g. Gemini
    // ?key=, ElevenLabs ?token=) stay out of the logs
    console.log(str.replace(/\?\S+/g, ""))
  }),
)

app.use(async (c, next) => {
  await next()
  c.res.headers.set("X-Accel-Buffering", "no")
})

app.get("/", (c) => c.text("A proxy for AI!"))

// Optional shared-secret gate: when PROXY_AUTH_TOKEN is set, every request
// (including /custom-model-proxy, which can relay anywhere) must carry it
// in the x-proxy-token header. Read per request so tests can toggle it.
export const isAuthorized = (token: string | string[] | undefined) => {
  const required = process.env.PROXY_AUTH_TOKEN
  return !required || token === required
}

app.use(async (c, next) => {
  if (!isAuthorized(c.req.header("x-proxy-token"))) {
    return c.text("Unauthorized", 401)
  }
  await next()
})

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

    // any non-abort failure here means the upstream couldn't be reached;
    // log without url.search and without the raw error object — query
    // strings (e.g. Gemini ?key=) and undici error messages can carry
    // client credentials
    const { origin, pathname } = new URL(url)
    const cause =
      error instanceof Error ? ((error.cause as Error) ?? error) : undefined
    const reason = cause
      ? ((cause as { code?: string }).code ?? cause.name)
      : String(error)
    console.error(`failed to reach ${origin}${pathname}: ${reason}`)
    return new Response("Bad Gateway", {
      status: 502,
    })
  }
}

const DEFAULT_TIMEOUT = 60000

// cap the proxied request body to avoid memory/bandwidth exhaustion; generous
// by default so base64 images / audio for the media providers still go through
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 100 * 1024 * 1024)

app.use(
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.text("Payload Too Large", 413),
  }),
)

// Is an IP literal in a loopback / private / link-local / reserved range?
const isPrivateIp = (ip: string): boolean => {
  const v = ip.replace(/^::ffff:/i, "") // unwrap IPv4-mapped IPv6
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number)
    return (
      a === 0 ||
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a >= 224 // multicast + reserved
    )
  }
  const lower = ip.toLowerCase()
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fe80") || // link-local
    lower.startsWith("fc") || // unique-local fc00::/7
    lower.startsWith("fd")
  )
}

// SSRF guard for /custom-model-proxy (which relays to an arbitrary url): block
// non-http(s) schemes and targets that resolve to internal addresses. Set
// CUSTOM_MODEL_PROXY_ALLOW_PRIVATE=1 to allow private targets on trusted nets.
const targetRejectionReason = async (target: URL): Promise<string | null> => {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return "only http(s) targets are allowed"
  }
  if (process.env.CUSTOM_MODEL_PROXY_ALLOW_PRIVATE === "1") return null
  const host = target.hostname.replace(/^\[|\]$/g, "") // strip IPv6 brackets
  let addresses: string[]
  try {
    addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((a) => a.address)
  } catch {
    return "could not resolve target host"
  }
  if (addresses.some(isPrivateIp)) {
    return "target resolves to a private or reserved address"
  }
  return null
}

export const isForwardableHeader = (name: string) => {
  const k = name.toLowerCase()
  return (
    !k.startsWith("cf-") &&
    !k.startsWith("x-forwarded-") &&
    !k.startsWith("cdn-") &&
    k !== "x-real-ip" &&
    k !== "host" &&
    // the proxy's own auth secret must never reach the upstream
    k !== "x-proxy-token"
  )
}

// Build the upstream headers: drop infra/proxy-internal ones and set Host
// from the target (incl. port for non-default ports).
const buildForwardHeaders = (incoming: Headers, target: URL) => {
  const headers = new Headers()
  headers.set("host", target.host)
  incoming.forEach((value, key) => {
    if (isForwardableHeader(key)) {
      headers.set(key, value)
    }
  })
  return headers
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

// extra routes from the environment without a code change, e.g.
// EXTRA_PROXIES='[{"pathSegment":"foo","target":"https://api.foo.example"}]'
if (process.env.EXTRA_PROXIES) {
  let extra: unknown
  try {
    extra = JSON.parse(process.env.EXTRA_PROXIES)
  } catch (error) {
    // don't echo the raw value — a target may embed credentials
    throw new Error(
      `EXTRA_PROXIES is not valid JSON: ${(error as Error).message}`,
    )
  }
  if (!Array.isArray(extra)) {
    throw new Error("EXTRA_PROXIES must be a JSON array")
  }
  for (const entry of extra) {
    if (
      typeof entry?.pathSegment !== "string" ||
      typeof entry?.target !== "string"
    ) {
      throw new Error(
        "EXTRA_PROXIES entries must be objects with string pathSegment and target",
      )
    }
    try {
      new URL(entry.target)
    } catch {
      throw new Error(
        `EXTRA_PROXIES entry "${entry.pathSegment}" has an invalid target URL`,
      )
    }
  }
  proxies.push(...(extra as typeof proxies))
}

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
    const target = new URL(url)

    // SSRF guard: this endpoint relays to an arbitrary url, so block
    // non-http(s) schemes and internal addresses (loopback/metadata/LAN)
    const rejection = await targetRejectionReason(target)
    if (rejection) {
      return c.text(rejection, 403)
    }

    // same hardening as the path-prefix route: filtered headers (no
    // x-proxy-token / infra leak to the arbitrary target), timeout, and
    // 502/504 instead of a raw 500
    const res = await fetchWithTimeout(url, {
      method: c.req.method,
      body: c.req.raw.body,
      headers: buildForwardHeaders(c.req.raw.headers, target),
      timeout: DEFAULT_TIMEOUT,
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
    const headers = buildForwardHeaders(
      c.req.raw.headers,
      new URL(proxy.target),
    )

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

  await next()
})

export default app
