# AI Proxy

This is a simple proxy for AI services.

## Sponsorship

This project is sponsored by [ChatWise](https://chatwise.app), the fastest AI chatbot that works for any LLM.

## Usage

Replace your API domain with the domain of the proxy deployed on your server. For example:

- Gemini:
  - from `https://generativelanguage.googleapis.com/v1beta`
  - to`https://your-proxy/generativelanguage/v1beta`
- OpenAI:
  - from `https://api.openai.com/v1`
  - to `https://your-proxy/openai/v1`
- Anthropic:
  - from `https://api.anthropic.com/v1`
  - to `https://your-proxy/anthropic/v1`
- Groq:
  - from `https://api.groq.com/openai/v1`
  - to `https://your-proxy/groq/openai/v1`
- Perplexity:
  - from `https://api.perplexity.ai`
  - to `https://your-proxy/pplx`
- Mistral:
  - from `https://api.mistral.ai`
  - to `https://your-proxy/mistral`
- OpenRouter:
  - from `https://openrouter.ai/api`
  - to `https://your-proxy/openrouter`
- xAI:
  - from `https://api.xai.ai`
  - to `https://your-proxy/xai`
- Cerebras:
  - from `https://api.cerebras.ai`
  - to `https://your-proxy/cerebras`
- fal.ai:
  - from `https://fal.run` (sync inference) to `https://your-proxy/fal`
  - from `https://queue.fal.run` (queue) to `https://your-proxy/fal-queue`
  - from `https://api.fal.ai` (platform API) to `https://your-proxy/fal-api`
  - from `https://rest.fal.ai` (realtime tokens, JWKS) to `https://your-proxy/fal-rest`
  - from `https://v3.fal.media` (file CDN) to `https://your-proxy/fal-media`
  - from `wss://ws.fal.run` (HTTP-over-WebSockets) to `wss://your-proxy/fal-ws`
- Kling AI:
  - global: from `https://api-singapore.klingai.com` to `https://your-proxy/kling`
  - China: from `https://api-beijing.klingai.com` to `https://your-proxy/kling-cn`
- Black Forest Labs (FLUX):
  - from `https://api.bfl.ai` to `https://your-proxy/bfl`
  - EU region: from `https://api.eu.bfl.ai` to `https://your-proxy/bfl-eu`
  - US region: from `https://api.us.bfl.ai` to `https://your-proxy/bfl-us`
- ElevenLabs:
  - from `https://api.elevenlabs.io` to `https://your-proxy/elevenlabs`
  - EU residency: from `https://api.eu.residency.elevenlabs.io` to `https://your-proxy/elevenlabs-eu`
  - India residency: from `https://api.in.residency.elevenlabs.io` to `https://your-proxy/elevenlabs-in`

### Notes on media providers (fal.ai, Kling, BFL, ElevenLabs)

- Authentication headers are passed through as-is: fal.ai `Authorization: Key ...`, Kling `Authorization: Bearer <JWT>` (signed client-side from AccessKey/SecretKey), BFL `x-key`, ElevenLabs `xi-api-key`.
- WebSocket endpoints are proxied transparently by the Node server (`server.ts`) via raw upgrade passthrough: fal `wss://your-proxy/fal-ws/{model_id}` and `wss://your-proxy/fal/{app}/realtime`, ElevenLabs realtime TTS/STT and Agents via `wss://your-proxy/elevenlabs/...`. Deployments that run `main.ts` on other runtimes (e.g. edge workers) do not get WS support.
- Running behind an egress HTTP proxy (e.g. a local VPN): WebSocket passthrough honors `https_proxy` automatically (CONNECT tunnel); for regular HTTP routes set `NODE_USE_ENV_PROXY=1` (Node 24+) so `fetch` honors it too.
- Some responses contain absolute upstream URLs which bypass the proxy when followed: fal queue `status_url`/`response_url`/`cancel_url`, BFL `polling_url` (may point to a regional cluster), result file links (fal.media, BFL delivery URLs, Kling CDN).
- Webhooks (fal `?fal_webhook=`, Kling `callback_url`, BFL `webhook_url`) are delivered by the provider directly to your callback host, not through this proxy.
- Long-running synchronous requests are supported: up to 10 minutes for `/fal` (sync video generation) and 5 minutes for `/elevenlabs` (speech-to-text on long audio). Prefer the queue/async APIs in production.

## Hosted by ChatWise

Use the hosted API, for example OpenAI `https://ai-proxy.chatwise.app/openai/v1`

## Deployment

Deploy this as a Docker container, check out [Dockerfile](./Dockerfile).

## License

MIT.
