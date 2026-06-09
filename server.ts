import { serve } from "@hono/node-server"
import type { Server, IncomingMessage } from "node:http"
import { connect as netConnect, type Socket } from "node:net"
import { connect as tlsConnect, type TLSSocket } from "node:tls"
import app, { isForwardableHeader, proxies } from "./main"

const port = Number(process.env.PORT || "4000")

const CONNECT_TIMEOUT = 15000

// Open a TLS connection to the upstream. Raw sockets don't honor
// https_proxy the way fetch does with NODE_USE_ENV_PROXY, so tunnel
// through the egress proxy with CONNECT when one is configured.
const connectUpstream = async (target: URL): Promise<TLSSocket> => {
  const targetPort = Number(target.port) || 443
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY

  let tunnel: Socket | undefined
  if (proxyUrl) {
    const proxy = new URL(proxyUrl)
    tunnel = await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect(
        { host: proxy.hostname, port: Number(proxy.port) || 80 },
        () => {
          socket.write(
            `CONNECT ${target.hostname}:${targetPort} HTTP/1.1\r\n` +
              `host: ${target.hostname}:${targetPort}\r\n\r\n`,
          )
        },
      )
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

  return new Promise<TLSSocket>((resolve, reject) => {
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

const server = serve({
  fetch: app.fetch,
  port,
}) as Server

// Transparent WebSocket passthrough: forward the upgrade request to the
// matched upstream and pipe bytes both ways without parsing WS frames
// (fal wss://ws.fal.run and realtime, ElevenLabs realtime TTS/STT etc.)
server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  // a sync throw (e.g. malformed request-target in new URL) would become
  // an unhandled rejection and kill the process
  handleUpgrade(req, socket, head).catch(() => socket.destroy())
})

const handleUpgrade = async (
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
) => {
  socket.on("error", () => socket.destroy())

  const url = new URL(req.url || "/", "http://localhost")
  const route = proxies.find((p) =>
    url.pathname.startsWith(`/${p.pathSegment}/`),
  )

  if (!route) {
    socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n")
    return
  }

  const target = new URL(route.target)
  const path = `${url.pathname.replace(`/${route.pathSegment}/`, "/")}${url.search}`

  const lines = [`${req.method} ${path} HTTP/1.1`, `host: ${target.hostname}`]
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (isForwardableHeader(req.rawHeaders[i])) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
  }

  let upstream: TLSSocket
  try {
    upstream = await connectUpstream(target)
  } catch {
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

console.log(`http://localhost:${port}`)
