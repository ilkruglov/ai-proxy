import type { IncomingMessage } from "node:http"
import { connect as netConnect, type Socket } from "node:net"
import { connect as tlsConnect } from "node:tls"
import { isForwardableHeader, isAuthorized, proxies } from "./main"

const CONNECT_TIMEOUT = 15000

// Open a connection to the upstream: TLS for https targets, a plain
// socket for http ones (local upstreams in tests/dev). Raw sockets
// don't honor https_proxy the way fetch does with NODE_USE_ENV_PROXY,
// so https connections tunnel through the egress proxy with CONNECT
// when one is configured.
export const connectUpstream = async (target: URL): Promise<Socket> => {
  if (target.protocol === "http:") {
    return new Promise<Socket>((resolve, reject) => {
      const socket = netConnect(
        { host: target.hostname, port: Number(target.port) || 80 },
        () => {
          socket.setTimeout(0)
          resolve(socket)
        },
      )
      socket.setTimeout(CONNECT_TIMEOUT, () =>
        socket.destroy(new Error("upstream connect timeout")),
      )
      socket.once("error", reject)
    })
  }

  const targetPort = Number(target.port) || 443
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY

  let tunnel: Socket | undefined
  if (proxyUrl) {
    const proxy = new URL(proxyUrl)
    // mirror undici's NODE_USE_ENV_PROXY (which serves the HTTP path): an
    // https:// egress proxy is reached over TLS, and userinfo becomes a
    // Proxy-Authorization header
    const proxyOverTls = proxy.protocol === "https:"
    const auth = proxy.username
      ? `proxy-authorization: Basic ${Buffer.from(
          `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        ).toString("base64")}\r\n`
      : ""
    tunnel = await new Promise<Socket>((resolve, reject) => {
      const onConnect = () => {
        socket.write(
          `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\n` +
            `host: ${target.hostname}:${targetPort}\r\n` +
            auth +
            `\r\n`,
        )
      }
      const proxyPort = Number(proxy.port) || (proxyOverTls ? 443 : 80)
      const socket = proxyOverTls
        ? tlsConnect(
            {
              host: proxy.hostname,
              port: proxyPort,
              servername: proxy.hostname,
            },
            onConnect,
          )
        : netConnect({ host: proxy.hostname, port: proxyPort }, onConnect)
      socket.setTimeout(CONNECT_TIMEOUT, () =>
        socket.destroy(new Error("proxy CONNECT timeout")),
      )
      let response = ""
      const onData = (chunk: Buffer) => {
        response += chunk.toString("latin1")
        if (!response.includes("\r\n\r\n")) return
        socket.off("data", onData)
        socket.setTimeout(0)
        if (/^HTTP\/1\.[01] 200/.test(response)) {
          resolve(socket)
        } else {
          socket.destroy(
            new Error(`proxy CONNECT failed: ${response.split("\r\n")[0]}`),
          )
        }
      }
      socket.on("data", onData)
      socket.once("error", reject)
      // a clean FIN mid-response emits no "error" — reject explicitly
      socket.once("close", () =>
        reject(new Error("proxy closed connection during CONNECT")),
      )
    })
  }

  return new Promise<Socket>((resolve, reject) => {
    const socket = tlsConnect({
      host: target.hostname,
      port: targetPort,
      servername: target.hostname,
      socket: tunnel,
    })
    socket.setTimeout(CONNECT_TIMEOUT, () =>
      socket.destroy(new Error("upstream connect timeout")),
    )
    socket.once("secureConnect", () => {
      socket.setTimeout(0)
      resolve(socket)
    })
    socket.once("error", reject)
  })
}

// Transparent WebSocket passthrough: forward the upgrade request to the
// matched upstream and pipe bytes both ways without parsing WS frames
// (fal wss://ws.fal.run and realtime, ElevenLabs realtime TTS/STT etc.)
export const handleUpgrade = async (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
) => {
  socket.on("error", () => socket.destroy())

  if (!isAuthorized(req.headers["x-proxy-token"])) {
    socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n")
    return
  }

  const url = new URL(req.url || "/", "http://localhost")
  const route = proxies.find((p) =>
    url.pathname.startsWith(`/${p.pathSegment}/`),
  )

  if (!route) {
    socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n")
    return
  }

  const target = new URL(route.target)
  // keep any path prefix on the target (e.g. openrouter -> .../api), like
  // the HTTP path does by concatenating target + rewritten pathname
  const basePath =
    target.pathname === "/" ? "" : target.pathname.replace(/\/$/, "")
  const path = `${basePath}${url.pathname.replace(`/${route.pathSegment}/`, "/")}${url.search}`

  const lines = [`${req.method} ${path} HTTP/1.1`, `host: ${target.host}`]
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (isForwardableHeader(req.rawHeaders[i])) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
  }

  let upstream: Socket
  try {
    upstream = await connectUpstream(target)
  } catch (error) {
    // mirror the HTTP path's redacted 502 log; these errors carry only the
    // upstream host and the egress-proxy status line, never client creds
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`failed to reach ${target.origin} (ws upgrade): ${reason}`)
    socket.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n")
    return
  }

  if (!socket.writable) {
    upstream.destroy()
    return
  }

  // latin1: rawHeaders carry bytes 0x80-0xFF as-is; a default utf8 write
  // would re-encode them and corrupt the request on the wire
  upstream.write(Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1"))
  if (head.length > 0) {
    upstream.write(head)
  }
  socket.pipe(upstream)
  upstream.pipe(socket)

  upstream.on("error", () => socket.destroy())
  upstream.on("close", () => socket.destroy())
  socket.on("close", () => upstream.destroy())
}
