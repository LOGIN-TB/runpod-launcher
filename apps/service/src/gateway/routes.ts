import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { POD_PORTS } from '@runpod-launcher/shared'
import { errors } from './errors.js'
import { reassembleStream } from './reassemble.js'

/** What the gateway needs to know about the pod it is fronting. */
export interface ActivePod {
  /** Base URL per role, already pointing at the right port. */
  chatUrl: string | null
  embeddingUrl: string | null
  /** Bearer token the pod's own servers expect — never the client's. */
  podApiKey: string
  /** Model names this pod actually answers to. */
  servedModels: readonly string[]
}

/**
 * Why no pod is available. The distinction matters to whoever reads the error:
 * "still starting, retry" and "nothing was ever started" call for different
 * actions, and conflating them sends people looking for a boot that never began.
 */
export type PodResolution =
  | { state: 'ready'; pod: ActivePod }
  | { state: 'starting' }
  | { state: 'none' }

export interface GatewayDeps {
  /**
   * Resolves the pod to route to, starting it if necessary.
   *
   * Waiting here rather than returning 503 immediately is deliberate: an
   * arbitrary agent knows nothing about `/wake`, so the first request after the
   * pod slept has to be the thing that wakes it.
   */
  resolvePod(options: { wait: boolean }): Promise<PodResolution>
  /**
   * Models to advertise, whether or not a pod is up.
   *
   * A client lists models before it can pick one. Advertising nothing while the
   * pod sleeps means it can never send the request that would wake it — the
   * agent simply reports "0 models" and stops. What a sleeping template would
   * serve is the honest answer, and asking for it is what starts the pod.
   */
  advertisedModels(): Promise<readonly string[]>

  authenticateClient(token: string): Promise<{ id: string; name: string } | null>
  recordUsage(entry: {
    tokenId: string
    endpoint: string
    model: string | null
    durationMs: number
  }): void
  wakeWaitSeconds(): number
}

const BEARER = /^Bearer\s+(.+)$/i

export async function registerGatewayRoutes(app: FastifyInstance, deps: GatewayDeps): Promise<void> {
  /** Authenticates and stashes the token identity on the request. */
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ id: string; name: string } | null> {
    const match = BEARER.exec(request.headers.authorization ?? '')
    const client = match?.[1] ? await deps.authenticateClient(match[1]) : null
    if (!client) {
      await reply.code(401).send(errors.unauthorized())
      return null
    }
    return client
  }

  app.get('/v1/models', async (request, reply) => {
    if (!(await authenticate(request, reply))) return

    const resolution = await deps.resolvePod({ wait: false }).catch(() => ({ state: 'none' }) as const)
    const servedModels =
      resolution.state === 'ready'
        ? resolution.pod.servedModels
        : // Nothing running: advertise what would be served, so a client can
          // choose it and let the request bring the pod up.
          await deps.advertisedModels().catch(() => [])
    const created = Math.floor(Date.now() / 1000)
    return reply.send({
      object: 'list',
      data: servedModels.map((id) => ({
        id,
        object: 'model',
        created,
        owned_by: 'runpod-launcher',
      })),
    })
  })

  app.post('/v1/chat/completions', (request, reply) => proxy(request, reply, 'chat', '/v1/chat/completions'))
  app.post('/v1/completions', (request, reply) => proxy(request, reply, 'chat', '/v1/completions'))
  app.post('/v1/embeddings', (request, reply) => proxy(request, reply, 'embedding', '/v1/embeddings'))

  async function proxy(
    request: FastifyRequest,
    reply: FastifyReply,
    role: 'chat' | 'embedding',
    upstreamPath: string,
  ): Promise<void> {
    const client = await authenticate(request, reply)
    if (!client) return

    const startedAt = Date.now()
    const body = request.body as Record<string, unknown> | undefined
    const requestedModel = typeof body?.model === 'string' ? body.model : null

    let resolution: PodResolution
    try {
      resolution = await deps.resolvePod({ wait: true })
    } catch (error) {
      // Anything thrown while resolving — a missing RunPod key, a RunPod
      // outage — must still leave the client with an OpenAI-shaped body. A
      // Fastify default error reads as "Unknown error" in every SDK, which is
      // how a clear "no API key configured" became an unexplained 500.
      await reply.code(503).send(errors.upstream((error as Error).message))
      return
    }

    if (resolution.state === 'none') {
      await reply.code(503).send(errors.noPod())
      return
    }
    if (resolution.state === 'starting') {
      reply.header('retry-after', '30')
      await reply.code(503).send(errors.stillStarting(deps.wakeWaitSeconds()))
      return
    }
    const pod = resolution.pod

    const upstreamBase = role === 'chat' ? pod.chatUrl : pod.embeddingUrl
    if (!upstreamBase) {
      await reply.code(400).send(errors.slotDisabled(role))
      return
    }

    if (requestedModel && !pod.servedModels.includes(requestedModel)) {
      await reply.code(404).send(errors.modelNotAvailable(requestedModel, pod.servedModels))
      return
    }

    // Always stream from the pod, whatever the client asked for.
    //
    // RunPod's HTTP proxy sits behind Cloudflare, which abandons a request that
    // produces nothing for 100 seconds. A long generation on a non-streaming
    // call therefore dies with an HTML error page rather than an answer.
    // Streaming keeps bytes moving; a client that wanted one object gets one,
    // reassembled below.
    const clientWantsStream = body?.stream === true
    const canStream = upstreamPath !== '/v1/embeddings'

    let upstream: Response
    try {
      upstream = await fetch(`${upstreamBase}${upstreamPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pod.podApiKey}`,
        },
        body: JSON.stringify(
          canStream
            ? {
                ...(body ?? {}),
                stream: true,
                // Engines omit token counts from a stream unless asked. Clients
                // use them to decide when to compact a conversation, and
                // without them an agent has to guess its own context usage.
                stream_options: { include_usage: true, ...(body?.stream_options as object) },
              }
            : (body ?? {}),
        ),
      })
    } catch (error) {
      await reply.code(502).send(errors.upstream((error as Error).message))
      return
    }

    deps.recordUsage({
      tokenId: client.id,
      endpoint: upstreamPath,
      model: requestedModel,
      durationMs: Date.now() - startedAt,
    })

    // RunPod's proxy answers 404 while nothing is bound to the pod's port. It
    // is indistinguishable from a real 404 at a glance, and passing it on tells
    // the client its request was wrong when the pod was merely not up yet.
    // Readiness is checked before forwarding, but the answer is cached for a
    // few seconds and an engine can fall over inside that window.
    if (upstream.status === 404 && !isEngineResponse(upstream)) {
      reply.header('retry-after', '30')
      await reply.code(503).send(errors.stillStarting(deps.wakeWaitSeconds()))
      return
    }

    reply.code(upstream.status)
    const contentType = upstream.headers.get('content-type')
    if (contentType) reply.header('content-type', contentType)

    if (!upstream.body) {
      await reply.send(await upstream.text())
      return
    }

    if (canStream && !clientWantsStream && upstream.ok) {
      // The client asked for a single object, so the stream is collected back
      // into one. Tool call arguments in particular arrive in fragments and are
      // concatenated — losing any part produces invalid JSON, which is exactly
      // what a truncated tool call looks like from the outside.
      reply.header('content-type', 'application/json')
      await reply.send(await reassembleStream(upstream.body))
      return
    }

    await reply.send(upstream.body)
  }
}

/**
 * Did this come from the inference engine, or from the proxy in front of it?
 *
 * An engine answers JSON. RunPod's proxy answers text or HTML when there is
 * nothing behind the port yet, so the content type separates "your request was
 * wrong" from "nobody is home".
 */
function isEngineResponse(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('application/json')
}

/** Builds the per-role upstream URLs for a pod, given how it is reachable. */
export function podRoleUrls(
  baseFor: (port: number) => string,
  slots: { chat: boolean; embedding: boolean },
): { chatUrl: string | null; embeddingUrl: string | null } {
  return {
    chatUrl: slots.chat ? baseFor(POD_PORTS.chat) : null,
    embeddingUrl: slots.embedding ? baseFor(POD_PORTS.embedding) : null,
  }
}
