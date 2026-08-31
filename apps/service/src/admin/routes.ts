import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { settingsPatchSchema, templateSchema, type Template } from '@runpod-launcher/shared'
import { generatePairingCode } from '../store/crypto.js'
import type { Db } from '../store/db.js'
import type { SettingsStore } from '../store/settings.js'
import type { TokenStore } from '../auth/tokens.js'
import type { PodManager } from '../pods/manager.js'
import type { PairingService } from '../auth/pairing.js'
import type { RunpodClient } from '../runpod/client.js'
import type { HuggingFaceClient } from '../models/huggingface.js'
import type { SpendTracker } from '../scheduler/spend.js'
import type { Scheduler } from '../scheduler/scheduler.js'

export interface AdminDeps {
  db: Db
  settings: SettingsStore
  tokens: TokenStore
  pods: PodManager
  pairing: PairingService
  requireRunpodKey: () => RunpodClient
  huggingface: HuggingFaceClient
  spend: SpendTracker
  scheduler: Scheduler
}

const BEARER = /^Bearer\s+(.+)$/i

/**
 * The control surface the desktop app talks to.
 *
 * Everything here needs a device token. Client tokens — the ones handed to n8n
 * or an agent — are deliberately rejected: consuming the model must never imply
 * permission to rent hardware.
 */
export async function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): Promise<void> {
  const { db, settings, tokens, pods, pairing } = deps

  const audit = (actor: string, action: string, detail: unknown, ip: string | undefined): void => {
    db.prepare('INSERT INTO audit_log (at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
      new Date().toISOString(),
      actor,
      action,
      detail === undefined ? null : JSON.stringify(detail),
      ip ?? null,
    )
  }

  async function requireDevice(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ id: string; name: string } | null> {
    const match = BEARER.exec(request.headers.authorization ?? '')
    const device = match?.[1] ? tokens.verify('devices', match[1]) : null
    if (!device) {
      await reply.code(401).send({ error: 'Not paired. Pair this app with the service first.' })
      return null
    }
    return device
  }

  app.post('/pair', async (request, reply) => {
    const body = request.body as { code?: string; deviceName?: string } | undefined
    const result = pairing.redeem(body?.code ?? '', body?.deviceName ?? '')
    if (!result.ok) {
      audit('unknown', 'pair.failed', { reason: result.reason }, request.ip)
      return reply.code(403).send({ error: result.reason })
    }
    audit(result.id, 'pair.succeeded', { deviceName: body?.deviceName }, request.ip)
    return reply.send({ deviceId: result.id, token: result.token })
  })

  /** Lets a paired device enrol another one without a container restart. */
  app.post('/pair/new-code', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const issued = pairing.issueNewCode(generatePairingCode())
    audit(device.id, 'pair.codeIssued', undefined, request.ip)
    return reply.send(issued)
  })

  app.get('/settings', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    return reply.send(settings.readPublic())
  })

  app.patch('/settings', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return

    const parsed = settingsPatchSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid settings', issues: parsed.error.issues })
    }
    settings.update(parsed.data)
    // Log which keys changed, never their values.
    audit(device.id, 'settings.updated', { keys: Object.keys(parsed.data) }, request.ip)
    return reply.send(settings.readPublic())
  })

  /** Confirms the stored RunPod key actually works, without changing anything. */
  app.post('/settings/verify-runpod', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    try {
      const valid = await deps.requireRunpodKey().verifyKey()
      return reply.send({ valid })
    } catch (error) {
      return reply.code(400).send({ valid: false, error: (error as Error).message })
    }
  })

  app.get('/templates', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    const rows = db.prepare('SELECT config FROM templates ORDER BY name').all() as Array<{ config: string }>
    return reply.send({ templates: rows.map((row) => JSON.parse(row.config) as Template) })
  })

  app.post('/templates', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return

    const parsed = templateSchema.safeParse({ id: randomUUID(), ...(request.body as object) })
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid template', issues: parsed.error.issues })
    }
    const now = new Date().toISOString()
    db.prepare(
      'INSERT INTO templates (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(parsed.data.id, parsed.data.name, JSON.stringify(parsed.data), now, now)
    audit(device.id, 'template.created', { id: parsed.data.id, name: parsed.data.name }, request.ip)
    return reply.code(201).send(parsed.data)
  })

  /**
   * GPU catalog with live availability.
   *
   * Availability is deliberately not cached. Capacity for the affordable 48 GB
   * cards sits at LOW and shifts within minutes; a stale "available" is how the
   * nightly rebuild silently fails to come back up.
   */
  /** Searches HuggingFace, scoped to models that suit the chosen slot. */
  app.get('/models/search', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    const query = request.query as { q?: string; kind?: string }
    if (!query.q) return reply.code(400).send({ error: 'q is required' })
    const kind = query.kind === 'embedding' ? 'embedding' : 'chat'
    try {
      return reply.send({ models: await deps.huggingface.search(query.q, kind) })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /**
   * Answers "will this run here?" before a pod is rented — format against
   * engine, format against GPU, and size against VRAM.
   */
  app.post('/models/evaluate', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    const body = request.body as {
      repoId?: string
      revision?: string
      variant?: string
      kind?: string
      engine?: string
      gpuDisplayName?: string
      gpuMemoryGb?: number
      otherSlotBytes?: number
    }
    if (!body?.repoId || !body.gpuDisplayName || !body.gpuMemoryGb) {
      return reply.code(400).send({ error: 'repoId, gpuDisplayName and gpuMemoryGb are required' })
    }
    try {
      return reply.send(
        await deps.huggingface.evaluate({
          repoId: body.repoId,
          ...(body.revision ? { revision: body.revision } : {}),
          ...(body.variant ? { variant: body.variant } : {}),
          kind: body.kind === 'embedding' ? 'embedding' : 'chat',
          engine: body.engine === 'llamacpp' ? 'llamacpp' : 'vllm',
          gpuDisplayName: body.gpuDisplayName,
          gpuMemoryGb: body.gpuMemoryGb,
          ...(body.otherSlotBytes ? { otherSlotBytes: body.otherSlotBytes } : {}),
        }),
      )
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /** What has been spent, and how much of it is still an estimate. */
  app.get('/spend', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    const settings = deps.settings.read()
    try {
      const snapshot = await deps.spend.snapshot()
      return reply.send({
        ...snapshot,
        dailyLimitUsd: settings.dailyLimitUsd,
        monthlyLimitUsd: settings.monthlyLimitUsd,
      })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /**
   * What the scheduler would do right now, and why.
   *
   * A schedule that silently does nothing is impossible to debug from the
   * outside — this makes the decision visible without waiting for 07:00.
   */
  app.get('/schedule/preview', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    try {
      // One entry per template with a schedule or a pod up, because each has
      // its own decision now — showing only the first would hide the rest.
      const actions = await deps.scheduler.preview(new Date())
      return reply.send({ actions })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  app.get('/catalog/gpus', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    try {
      const { gpus } = await deps.requireRunpodKey().listGpuTypes({ availability: true })
      return reply.send({ gpus })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  app.get('/catalog/datacenters', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    try {
      const { dataCenters } = await deps.requireRunpodKey().listDataCenters()
      return reply.send({ dataCenters })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  app.get('/network-volumes', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    try {
      const { networkVolumes } = await deps.requireRunpodKey().listNetworkVolumes()
      return reply.send({ networkVolumes })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /**
   * Creates a network volume. This is the one action here that commits the user
   * to a recurring charge and pins every future pod to one data center, so it
   * is logged with its full parameters.
   */
  app.post('/network-volumes', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return

    const body = request.body as { name?: string; size?: number; dataCenter?: string } | undefined
    if (!body?.name || !body.size || !body.dataCenter) {
      return reply.code(400).send({ error: 'name, size and dataCenter are required' })
    }
    try {
      const volume = await deps
        .requireRunpodKey()
        .createNetworkVolume({ name: body.name, size: body.size, dataCenter: body.dataCenter })
      audit(device.id, 'networkVolume.created', body, request.ip)
      return reply.code(201).send(volume)
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /**
   * What has happened recently, and who did it.
   *
   * The log has existed since the first commit and was never shown, so a pod
   * that the scheduler stopped for being outside its hours looked to the user
   * like a pod that had failed for no reason.
   */
  app.get('/activity', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    const rows = db
      .prepare('SELECT at, actor, action, detail FROM audit_log ORDER BY id DESC LIMIT 30')
      .all() as Array<{ at: string; actor: string; action: string; detail: string | null }>

    return reply.send({
      events: rows.map((row) => ({
        at: row.at,
        // Only whether it was the schedule or a person — device ids mean
        // nothing to the person reading.
        by: row.actor === 'scheduler' ? 'schedule' : 'you',
        action: row.action,
        detail: row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : null,
      })),
    })
  })

  /** Every pod, with how far along each one is. */
  app.get('/pods', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    try {
      return reply.send({ pods: await pods.listAll() })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /** Resume a paused pod and route the gateway at it. */
  app.post('/pods/:id/start', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }
    try {
      const record = await pods.resume(id)
      audit(device.id, 'pod.start', { podId: id }, request.ip)
      return reply.send(record)
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /** Pause a specific pod. It keeps its disk and can be resumed. */
  app.post('/pods/:id/stop', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }
    try {
      await pods.act(id, 'stop')
      audit(device.id, 'pod.stop', { podId: id }, request.ip)
      return reply.send({ stopped: id })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /**
   * Delete a pod for good.
   *
   * Separate from stopping on purpose: a stopped pod still bills for its disk,
   * so the difference between the two is money, and the interface should not
   * blur it.
   */
  app.delete('/pods/:id', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }
    try {
      await pods.act(id, 'terminate', 'deleted')
      audit(device.id, 'pod.terminate', { podId: id }, request.ip)
      return reply.code(204).send()
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  /**
   * Sends a real request to the active pod and reports what came back.
   *
   * "Running" is not the same as "working": the engine can be up and still
   * refuse every request. This is the only check that answers the question the
   * user is actually asking.
   */
  app.post('/pod/selftest', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    const asked = (request.body as { templateId?: string } | undefined)?.templateId
    const templateId = asked ?? pods.current()?.templateId
    const serving = templateId ? pods.describeFor(templateId) : null
    if (!serving) return reply.send({ ok: false, reason: 'no-pod' })

    const target = serving.chatUrl ?? serving.embeddingUrl
    const model = serving.servedModels[0]
    if (!target || !model) return reply.send({ ok: false, reason: 'no-endpoint' })

    const isChat = serving.chatUrl !== null
    const startedAt = Date.now()
    try {
      const response = await fetch(`${target}${isChat ? '/v1/chat/completions' : '/v1/embeddings'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serving.podApiKey}` },
        body: JSON.stringify(
          isChat
            ? { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }
            : { model, input: 'ping' },
        ),
        signal: AbortSignal.timeout(60_000),
      })
      const body = await response.text()
      return reply.send({
        ok: response.ok,
        status: response.status,
        durationMs: Date.now() - startedAt,
        ...(response.ok ? {} : { detail: body.slice(0, 300) }),
      })
    } catch (error) {
      return reply.send({ ok: false, reason: 'unreachable', detail: (error as Error).message })
    }
  })

  /**
   * Replaces a template.
   *
   * Editing was missing entirely, which left the launcher telling people to
   * "add fallback GPUs to the template" with no way to do it.
   */
  app.put('/templates/:id', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }

    const existing = db.prepare('SELECT id FROM templates WHERE id = ?').get(id)
    if (!existing) return reply.code(404).send({ error: 'Unknown template' })

    const parsed = templateSchema.safeParse({ ...(request.body as object), id })
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid template', issues: parsed.error.issues })
    }

    db.prepare('UPDATE templates SET name = ?, config = ?, updated_at = ? WHERE id = ?').run(
      parsed.data.name,
      JSON.stringify(parsed.data),
      new Date().toISOString(),
      id,
    )
    audit(device.id, 'template.updated', { id, name: parsed.data.name }, request.ip)
    // A running pod keeps the settings it was built with; the change applies to
    // the next pod. Saying so beats letting somebody wonder why nothing moved.
    return reply.send({ ...parsed.data, appliesToNextPod: pods.currentFor(id) !== null })
  })

  app.delete('/templates/:id', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }

    // Refuse while it is in use rather than leaving a running pod with no
    // template behind it — that pod would still bill and could not be resumed.
    if (pods.currentFor(id)) {
      return reply.code(409).send({ error: 'This template has a pod running. Stop the pod first.' })
    }
    db.prepare('DELETE FROM templates WHERE id = ?').run(id)
    audit(device.id, 'template.deleted', { id }, request.ip)
    return reply.code(204).send()
  })

  app.get('/pod', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    // A named template's pod when asked for one, otherwise the newest — the
    // setup wizard only wants to know whether anything is up yet. The full
    // picture is `/pods`.
    const asked = (request.query as { templateId?: string } | undefined)?.templateId
    const record = asked ? pods.currentFor(asked) : pods.current()
    const serving = record ? pods.describeFor(record.templateId) : null

    // Whether a pod has ever existed here, which is a different question from
    // whether one is up. The setup guide asks the first — "has a start been
    // through once" — and reading the second made its third step reopen itself
    // every time the pod stopped, with a "check again" button that could never
    // complete it.
    const { count } = db.prepare('SELECT COUNT(*) AS count FROM pods').get() as { count: number }

    return reply.send({
      pod: record,
      everStarted: count > 0,
      // `describeFor()` carries the pod's own bearer token because the gateway
      // needs it to reach vLLM. It must never travel further than that — a
      // client holding it could talk to the pod directly, outside the gateway,
      // with no usage record and no way to revoke it short of a rebuild.
      serving: serving && {
        chatUrl: serving.chatUrl,
        embeddingUrl: serving.embeddingUrl,
        servedModels: serving.servedModels,
      },
    })
  })

  app.post('/pod/start', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return

    const templateId = (request.body as { templateId?: string } | undefined)?.templateId
    const template = templateId ? pods.template(templateId) : null
    if (!template) return reply.code(400).send({ error: 'Unknown template' })

    try {
      const record = await pods.start(template)
      audit(device.id, 'pod.start', { podId: record.id, template: template.name }, request.ip)
      return reply.send(record)
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  app.post('/pod/stop', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return

    // Which pod, since several may be up. Without an explicit template this
    // stops the newest, which is what a single-pod installation means by it.
    const asked = (request.body as { templateId?: string } | undefined)?.templateId
    const record = asked ? pods.currentFor(asked) : pods.current()
    const template = record ? pods.template(record.templateId) : null
    try {
      if (record) await pods.stop(record.templateId, template?.lifecycleMode ?? 'recreate')
      audit(device.id, 'pod.stop', { podId: record?.id }, request.ip)
      return reply.send({ stopped: record?.id ?? null })
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message })
    }
  })

  app.get('/client-tokens', async (request, reply) => {
    if (!(await requireDevice(request, reply))) return
    return reply.send({ tokens: tokens.list('client_tokens') })
  })

  app.post('/client-tokens', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const body = request.body as { name?: string; templateId?: string | null } | undefined
    const name = body?.name ?? 'Unnamed client'

    // The target is set at issue time so a new access is usable straight away.
    // Unknown ids are refused rather than stored: a token pointing at a
    // template that does not exist fails at the worst moment, on the first
    // request, with nothing to explain it.
    const templateId = body?.templateId ?? null
    if (templateId && !pods.template(templateId)) {
      return reply.code(400).send({ error: 'Unknown template' })
    }

    const issued = tokens.issue('client_tokens', name, templateId)
    audit(device.id, 'clientToken.issued', { id: issued.id, name, templateId }, request.ip)
    // The only time this value is ever visible.
    return reply.code(201).send(issued)
  })

  /**
   * Points an existing access at a template.
   *
   * Re-pointing here rather than at the client is the point of hanging the
   * target on the token: the credential n8n holds stays valid, so moving it to
   * other hardware needs no change on the n8n side at all.
   */
  app.patch('/client-tokens/:id', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }
    const templateId = (request.body as { templateId?: string | null } | undefined)?.templateId ?? null
    if (templateId && !pods.template(templateId)) {
      return reply.code(400).send({ error: 'Unknown template' })
    }

    const known = tokens.list('client_tokens').some((token) => token.id === id)
    if (!known) return reply.code(404).send({ error: 'Unknown client token' })

    tokens.assign(id, templateId)
    audit(device.id, 'clientToken.assigned', { id, templateId }, request.ip)
    return reply.send({ id, templateId })
  })

  /** Blocks an access. This is what stops it working. */
  app.post('/client-tokens/:id/revoke', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }
    tokens.revoke('client_tokens', id)
    audit(device.id, 'clientToken.revoked', { id }, request.ip)
    return reply.code(204).send()
  })

  /**
   * Removes a blocked access from the list for good.
   *
   * Refused while it is still active, on purpose: tidying the list must not be
   * the gesture that also cuts off a running client. Block it first, see that
   * nothing broke, then remove it.
   */
  app.delete('/client-tokens/:id', async (request, reply) => {
    const device = await requireDevice(request, reply)
    if (!device) return
    const { id } = request.params as { id: string }
    if (!tokens.delete('client_tokens', id)) {
      return reply.code(409).send({ error: 'Block this access first, then it can be removed.' })
    }
    audit(device.id, 'clientToken.deleted', { id }, request.ip)
    return reply.code(204).send()
  })
}
