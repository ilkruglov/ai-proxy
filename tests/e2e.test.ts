import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  connect as netConnect,
  createServer as createNetServer,
  type Server as NetServer,
  type AddressInfo,
} from "node:net"
import { connectUpstream } from "../ws"

// Bun's node:http compat fires "upgrade" but the raw socket does not
// deliver writes, so the passthrough is tested e2e against the real
// production entry point: `bun build` output running under Node.

const BUILD_DIR = ".tmp/test-dist"

type SpawnedServer = {
  proc: Bun.Subprocess
  port: number
  stderr: () => string
}

let upstream: ReturnType<typeof Bun.serve>
let servers: SpawnedServer[] = []
let mainServer: SpawnedServer
let proxyPort: number
let authedPort: number
let upstreamHeaders: Record<string, string> = {}
let upstreamPath = ""

const listen = (server: NetServer): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  )

// ask the OS for a free port; small TOCTOU window, but far less collision-
// prone than a fixed pid-derived port across parallel CI runs
const freePort = async (): Promise<number> => {
  const probe = createNetServer()
  const port = await listen(probe)
  await new Promise((r) => probe.close(r))
  return port
}

const spawnServer = async (
  env: Record<string, string>,
): Promise<SpawnedServer> => {
  const port = await freePort()
  const proc = Bun.spawn(["node", `${BUILD_DIR}/server.js`], {
    env: {
      PATH: process.env.PATH!,
      PORT: String(port),
      EXTRA_PROXIES: JSON.stringify([
        { pathSegment: "test-ws", target: `http://127.0.0.1:${upstream.port}` },
        {
          pathSegment: "test-ws-base",
          target: `http://127.0.0.1:${upstream.port}/base`,
        },
        { pathSegment: "test-ws-down", target: "http://127.0.0.1:1" },
      ]),
      ...env,
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  let stderrBuf = ""
  ;(async () => {
    const decoder = new TextDecoder()
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderrBuf += decoder.decode(value)
    }
  })()
  const server: SpawnedServer = { proc, port, stderr: () => stderrBuf }
  try {
    for (let i = 0; i < 100; i++) {
      if (proc.exitCode !== null) {
        throw new Error(
          `server on :${port} exited early (${proc.exitCode}):\n${stderrBuf}`,
        )
      }
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        if (res.ok) return server
      } catch {}
      await Bun.sleep(100)
    }
    throw new Error(`server on :${port} did not become ready:\n${stderrBuf}`)
  } catch (error) {
    proc.kill()
    throw error
  }
}

// send a raw HTTP payload, return whatever comes back until close/timeout
const rawRequest = (port: number, payload: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => socket.write(payload))
    let data = ""
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(data)
    }, 3000)
    socket.on("data", (chunk) => (data += chunk.toString()))
    socket.on("close", () => {
      clearTimeout(timer)
      resolve(data)
    })
    socket.on("error", reject)
  })

// settle a possibly-never-resolving promise so a regression fails the
// assertion cleanly instead of hanging the whole run on a dangling handle
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("did not settle in time")), ms),
    ),
  ])

const upgradePayload = (path: string, extraHeaders = "") =>
  `GET ${path} HTTP/1.1\r\n` +
  `host: 127.0.0.1\r\n` +
  `connection: upgrade\r\n` +
  `upgrade: websocket\r\n` +
  `sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
  `sec-websocket-version: 13\r\n` +
  extraHeaders +
  `\r\n`

const wsEcho = (
  url: string,
  message: string,
  headers?: Record<string, string>,
): Promise<string> =>
  new Promise((resolve, reject) => {
    // per-connection headers are a Bun extension absent from the DOM types
    const ws = new WebSocket(url, { headers } as unknown as string[])
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error("ws echo timeout"))
    }, 5000)
    ws.onopen = () => ws.send(message)
    ws.onmessage = (e) => {
      clearTimeout(timer)
      ws.close()
      resolve(String(e.data))
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error("ws error"))
    }
  })

beforeAll(async () => {
  const build = Bun.spawnSync([
    "bun",
    "build",
    "server.ts",
    "main.ts",
    "--outdir",
    BUILD_DIR,
    "--packages",
    "external",
  ])
  if (build.exitCode !== 0) {
    throw new Error(`bun build failed: ${build.stderr.toString()}`)
  }

  upstream = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, server) {
      upstreamHeaders = {}
      req.headers.forEach((value, key) => {
        upstreamHeaders[key] = value
      })
      upstreamPath = new URL(req.url).pathname
      if (server.upgrade(req)) return undefined as unknown as Response
      return new Response("not a websocket", { status: 426 })
    },
    websocket: {
      message(ws, message) {
        ws.send(message)
      },
    },
  })

  servers = await Promise.all([
    spawnServer({}),
    spawnServer({ PROXY_AUTH_TOKEN: "s3cret" }),
  ])
  mainServer = servers[0]
  proxyPort = servers[0].port
  authedPort = servers[1].port
})

afterAll(() => {
  for (const server of servers) server.proc.kill()
  upstream.stop(true)
})

describe("websocket passthrough (e2e, node runtime)", () => {
  test("101 handshake and frames flow both ways", async () => {
    const echoed = await wsEcho(
      `ws://127.0.0.1:${proxyPort}/test-ws/`,
      "ping-through-proxy",
    )
    expect(echoed).toBe("ping-through-proxy")
  })

  test("infra headers are stripped on upgrade, auth ones forwarded", async () => {
    await wsEcho(`ws://127.0.0.1:${proxyPort}/test-ws/`, "x", {
      "cf-connecting-ip": "1.2.3.4",
      "x-proxy-token": "proxy-secret",
      authorization: "Key user-key",
    })
    expect(upstreamHeaders["cf-connecting-ip"]).toBeUndefined()
    expect(upstreamHeaders["x-proxy-token"]).toBeUndefined()
    expect(upstreamHeaders["authorization"]).toBe("Key user-key")
  })

  test("404 for unknown path prefixes", async () => {
    const res = await rawRequest(proxyPort, upgradePayload("/no-such/route"))
    expect(res).toStartWith("HTTP/1.1 404")
  })

  test("502 when the upstream is unreachable", async () => {
    const res = await rawRequest(proxyPort, upgradePayload("/test-ws-down/x"))
    expect(res).toStartWith("HTTP/1.1 502")
  })

  test("malformed request-target does not kill the server", async () => {
    await rawRequest(
      proxyPort,
      `GET http:// HTTP/1.1\r\nhost: x\r\nconnection: upgrade\r\nupgrade: websocket\r\n\r\n`,
    )
    // the server must still answer a healthy request afterwards
    const echoed = await wsEcho(
      `ws://127.0.0.1:${proxyPort}/test-ws/`,
      "still-alive",
    )
    expect(echoed).toBe("still-alive")
  })

  test("HTTP requests of the node build are proxied too", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/test-ws/plain`)
    expect(res.status).toBe(426) // upstream answers plain HTTP with 426
  })

  test("keeps the path prefix of a target that has one", async () => {
    await wsEcho(`ws://127.0.0.1:${proxyPort}/test-ws-base/v1/realtime`, "x")
    expect(upstreamPath).toBe("/base/v1/realtime")
  })

  test("502 with a redacted error log when the upstream is unreachable", async () => {
    const res = await fetch(
      `http://127.0.0.1:${proxyPort}/test-ws-down/v1/x?key=VERY_SECRET_KEY`,
      { method: "POST", body: "{}" },
    )
    expect(res.status).toBe(502)
    await Bun.sleep(200)
    const log = mainServer.stderr()
    expect(log).toContain("failed to reach")
    expect(log).not.toContain("VERY_SECRET_KEY")
  })
})

describe("EXTRA_PROXIES validation", () => {
  test("a malformed value fails startup with an actionable, secret-free error", async () => {
    const proc = Bun.spawn(["node", `${BUILD_DIR}/server.js`], {
      env: {
        PATH: process.env.PATH!,
        PORT: String(await freePort()),
        EXTRA_PROXIES: '[{"pathSegment":"x","target":"https://u:tok@h.example"',
      },
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = await new Response(proc.stderr as ReadableStream).text()
    const exitCode = await proc.exited
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("EXTRA_PROXIES")
    // the raw value (with embedded credentials) must not be echoed
    expect(stderr).not.toContain("tok@h.example")
  })

  test("a non-array value is rejected", async () => {
    const proc = Bun.spawn(["node", `${BUILD_DIR}/server.js`], {
      env: {
        PATH: process.env.PATH!,
        PORT: String(await freePort()),
        EXTRA_PROXIES: '{"pathSegment":"x","target":"https://h.example"}',
      },
      stdout: "ignore",
      stderr: "pipe",
    })
    const stderr = await new Response(proc.stderr as ReadableStream).text()
    expect(await proc.exited).not.toBe(0)
    expect(stderr).toContain("EXTRA_PROXIES must be a JSON array")
  })
})

describe("PROXY_AUTH_TOKEN gate on upgrades (e2e)", () => {
  test("rejects a missing token, accepts the right one", async () => {
    const denied = await rawRequest(authedPort, upgradePayload("/test-ws/"))
    expect(denied).toStartWith("HTTP/1.1 401")

    const echoed = await wsEcho(
      `ws://127.0.0.1:${authedPort}/test-ws/`,
      "authed",
      { "x-proxy-token": "s3cret" },
    )
    expect(echoed).toBe("authed")
  })
})

describe("connectUpstream CONNECT tunnel", () => {
  test("sends a well-formed CONNECT, with Basic auth from proxy userinfo", async () => {
    let connectReq = ""
    const proxyServer = createNetServer((socket) => {
      socket.on("data", (chunk) => {
        connectReq += chunk.toString()
        // accept, then drop so the TLS leg fails fast (we only assert the
        // CONNECT request the proxy received)
        socket.end("HTTP/1.1 200 Connection Established\r\n\r\n")
      })
    })
    const port = await listen(proxyServer)
    process.env.https_proxy = `http://user:p@ss@127.0.0.1:${port}`
    try {
      // swallow: the TLS handshake to the dropped socket will fail
      await connectUpstream(new URL("https://api.upstream.test:8443")).catch(
        () => {},
      )
      expect(connectReq).toStartWith(
        "CONNECT api.upstream.test:8443 HTTP/1.1\r\n",
      )
      expect(connectReq).toContain("host: api.upstream.test:8443\r\n")
      // "user:p@ss" base64-encoded
      const expected = Buffer.from("user:p@ss").toString("base64")
      expect(connectReq).toContain(`proxy-authorization: Basic ${expected}\r\n`)
    } finally {
      delete process.env.https_proxy
      proxyServer.close()
    }
  })

  test("rejects when the egress proxy refuses CONNECT", async () => {
    const badProxy = createNetServer((socket) => {
      socket.on("data", () => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"))
    })
    const badPort = await listen(badProxy)
    process.env.https_proxy = `http://127.0.0.1:${badPort}`
    try {
      await expect(
        withTimeout(connectUpstream(new URL("https://upstream.invalid")), 3000),
      ).rejects.toThrow("proxy CONNECT failed")
    } finally {
      delete process.env.https_proxy
      badProxy.close()
    }
  })

  test("rejects (instead of hanging) when the proxy closes mid-response", async () => {
    // regression: this used to leave the CONNECT promise pending forever
    const flakyProxy = createNetServer((socket) => {
      socket.on("data", () => {
        socket.write("HTTP/1.1 2")
        socket.end()
      })
    })
    const flakyPort = await listen(flakyProxy)
    process.env.https_proxy = `http://127.0.0.1:${flakyPort}`
    try {
      await expect(
        withTimeout(connectUpstream(new URL("https://upstream.invalid")), 3000),
      ).rejects.toThrow("proxy closed connection during CONNECT")
    } finally {
      delete process.env.https_proxy
      flakyProxy.close()
    }
  })
})
