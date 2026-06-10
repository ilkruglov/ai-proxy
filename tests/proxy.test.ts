import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import app, { proxies } from "../main"

const headersToObject = (headers: Headers) => {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

let upstream: ReturnType<typeof Bun.serve>
let upstreamPort: number

const TEST_SEGMENTS = ["test-upstream", "test-slow"]

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/next" },
        })
      }
      if (url.pathname === "/slow") {
        await Bun.sleep(400)
        return new Response("late")
      }
      return Response.json({
        method: req.method,
        path: url.pathname,
        search: url.search,
        headers: headersToObject(req.headers),
        body: await req.text(),
      })
    },
  })
  upstreamPort = upstream.port!

  proxies.push(
    {
      pathSegment: "test-upstream",
      target: `http://127.0.0.1:${upstreamPort}`,
    },
    {
      pathSegment: "test-slow",
      target: `http://127.0.0.1:${upstreamPort}`,
      timeout: 100,
    },
  )
})

afterAll(() => {
  upstream.stop(true)
  for (const segment of TEST_SEGMENTS) {
    const i = proxies.findIndex((p) => p.pathSegment === segment)
    if (i !== -1) proxies.splice(i, 1)
  }
})

describe("path-prefix proxying", () => {
  test("forwards method, rewritten path, query and body", async () => {
    const res = await app.request("/test-upstream/v1/things?a=1&b=2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    })
    expect(res.status).toBe(200)
    const echo = await res.json()
    expect(echo.method).toBe("POST")
    expect(echo.path).toBe("/v1/things")
    expect(echo.search).toBe("?a=1&b=2")
    expect(echo.body).toBe(JSON.stringify({ hello: "world" }))
  })

  test("forwards auth headers, strips infra and proxy-internal ones", async () => {
    const res = await app.request("/test-upstream/v1/headers", {
      headers: {
        authorization: "Key user-key",
        "xi-api-key": "user-key-2",
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "1.2.3.4",
        "cdn-loop": "cloudflare",
        "x-proxy-token": "proxy-secret",
      },
    })
    const { headers } = await res.json()
    expect(headers["authorization"]).toBe("Key user-key")
    expect(headers["xi-api-key"]).toBe("user-key-2")
    expect(headers["cf-connecting-ip"]).toBeUndefined()
    expect(headers["x-forwarded-for"]).toBeUndefined()
    expect(headers["x-real-ip"]).toBeUndefined()
    expect(headers["cdn-loop"]).toBeUndefined()
    expect(headers["x-proxy-token"]).toBeUndefined()
    expect(headers["host"]).toStartWith("127.0.0.1")
  })

  test("passes redirects through instead of following them", async () => {
    const res = await app.request("/test-upstream/redirect")
    expect(res.status).toBe(302)
    expect(res.headers.get("location")).toBe("https://example.com/next")
  })

  test("404 for unknown path prefixes", async () => {
    const res = await app.request("/no-such-provider/v1/x")
    expect(res.status).toBe(404)
  })

  // NB: the unreachable-upstream → 502 path is covered in e2e.test.ts —
  // under Bun a refused connection yields a synthetic 503 response instead
  // of the exception Node throws, so it can't be asserted in-process here

  test("504 when the upstream exceeds the per-route timeout", async () => {
    const res = await app.request("/test-slow/slow")
    expect(res.status).toBe(504)
  })
})

describe("log redaction", () => {
  test("query strings never reach the request log", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {})
    try {
      await app.request("/test-upstream/v1/models?key=VERY_SECRET_KEY")
      const logged = logSpy.mock.calls.flat().join("\n")
      expect(logged).toContain("/test-upstream/v1/models")
      expect(logged).not.toContain("VERY_SECRET_KEY")
    } finally {
      logSpy.mockRestore()
    }
  })
})

describe("PROXY_AUTH_TOKEN gate", () => {
  test("disabled by default: requests pass without a token", async () => {
    const res = await app.request("/test-upstream/v1/open")
    expect(res.status).toBe(200)
  })

  test("rejects missing or wrong tokens, accepts the right one", async () => {
    process.env.PROXY_AUTH_TOKEN = "s3cret"
    try {
      expect((await app.request("/test-upstream/v1/x")).status).toBe(401)
      expect(
        (
          await app.request("/test-upstream/v1/x", {
            headers: { "x-proxy-token": "wrong" },
          })
        ).status,
      ).toBe(401)

      const ok = await app.request("/test-upstream/v1/x", {
        headers: { "x-proxy-token": "s3cret" },
      })
      expect(ok.status).toBe(200)
      // the gate header must not leak to the upstream
      const { headers } = await ok.json()
      expect(headers["x-proxy-token"]).toBeUndefined()
    } finally {
      delete process.env.PROXY_AUTH_TOKEN
    }
  })

  test("gates /custom-model-proxy too", async () => {
    process.env.PROXY_AUTH_TOKEN = "s3cret"
    try {
      const target = encodeURIComponent(
        `http://127.0.0.1:${upstreamPort}/v1/custom`,
      )
      const res = await app.request(`/custom-model-proxy?url=${target}`, {
        method: "POST",
        body: "{}",
      })
      expect(res.status).toBe(401)
    } finally {
      delete process.env.PROXY_AUTH_TOKEN
    }
  })

  test("the root banner stays open for health checks", async () => {
    process.env.PROXY_AUTH_TOKEN = "s3cret"
    try {
      const res = await app.request("/")
      expect(res.status).toBe(200)
    } finally {
      delete process.env.PROXY_AUTH_TOKEN
    }
  })
})

describe("custom-model-proxy", () => {
  // the upstream is on loopback, which the SSRF guard blocks by default
  beforeAll(() => {
    process.env.CUSTOM_MODEL_PROXY_ALLOW_PRIVATE = "1"
  })
  afterAll(() => {
    delete process.env.CUSTOM_MODEL_PROXY_ALLOW_PRIVATE
  })

  test("proxies to the url query param", async () => {
    const target = encodeURIComponent(
      `http://127.0.0.1:${upstreamPort}/v1/custom`,
    )
    const res = await app.request(`/custom-model-proxy?url=${target}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    })
    expect(res.status).toBe(200)
    const echo = await res.json()
    expect(echo.path).toBe("/v1/custom")
    expect(echo.body).toBe(JSON.stringify({ x: 1 }))
    // host is reset to the target, infra headers are not leaked
    expect(echo.headers["host"]).toStartWith("127.0.0.1")
  })

  test("never forwards the proxy auth secret to the arbitrary target", async () => {
    process.env.PROXY_AUTH_TOKEN = "s3cret"
    try {
      const target = encodeURIComponent(
        `http://127.0.0.1:${upstreamPort}/v1/custom`,
      )
      const res = await app.request(`/custom-model-proxy?url=${target}`, {
        method: "POST",
        headers: { "x-proxy-token": "s3cret", authorization: "Key user-key" },
        body: "{}",
      })
      expect(res.status).toBe(200)
      const { headers } = await res.json()
      expect(headers["x-proxy-token"]).toBeUndefined()
      expect(headers["authorization"]).toBe("Key user-key")
    } finally {
      delete process.env.PROXY_AUTH_TOKEN
    }
  })
})

describe("custom-model-proxy SSRF guard", () => {
  test("blocks loopback targets by default", async () => {
    const target = encodeURIComponent(`http://127.0.0.1:${upstreamPort}/x`)
    const res = await app.request(`/custom-model-proxy?url=${target}`, {
      method: "POST",
      body: "{}",
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain("private")
  })

  test("blocks RFC1918 and link-local literals", async () => {
    for (const host of ["http://10.0.0.5/x", "http://169.254.169.254/x"]) {
      const res = await app.request(
        `/custom-model-proxy?url=${encodeURIComponent(host)}`,
        { method: "POST", body: "{}" },
      )
      expect(res.status).toBe(403)
    }
  })

  test("blocks non-http(s) schemes", async () => {
    const res = await app.request(
      `/custom-model-proxy?url=${encodeURIComponent("ftp://example.com/x")}`,
      { method: "POST", body: "{}" },
    )
    // zod's .url() may reject some schemes (400) before us; either is a refusal
    expect([400, 403]).toContain(res.status)
  })
})
