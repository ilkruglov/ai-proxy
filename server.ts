import { serve } from "@hono/node-server"
import type { Server, IncomingMessage } from "node:http"
import type { Socket } from "node:net"
import app from "./main"
import { handleUpgrade } from "./ws"

const port = Number(process.env.PORT || "4000")

const server = serve({
  fetch: app.fetch,
  port,
}) as Server

server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
  // a sync throw (e.g. malformed request-target in new URL) would become
  // an unhandled rejection and kill the process. req.url is omitted from the
  // log since it can carry credentials in the query string.
  handleUpgrade(req, socket, head).catch((error) => {
    console.error(
      `ws upgrade handler error: ${error instanceof Error ? error.message : String(error)}`,
    )
    socket.destroy()
  })
})

console.log(`http://localhost:${port}`)
