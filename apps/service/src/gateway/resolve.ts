import { isInsideWindow } from '../scheduler/decide.js'
import type { PodManager } from '../pods/manager.js'
import type { AdvertisedModels, GatewayDeps, GatewayIdentity, PodResolution } from './routes.js'

/**
 * Turns "who is calling" into "which pod does this go to".
 *
 * Its own module rather than a closure inside the server, because this is the
 * one decision in the launcher that spends money: it can start a pod. Tested
 * here against a real manager and a real database, which is the only way to
 * show that a request on n8n's token reaches n8n's pod and not the one a local
 * agent rented.
 */
export function createPodResolver(deps: {
  pods: PodManager
  wakeWaitSeconds: () => number
  now?: () => Date
}): Pick<GatewayDeps, 'resolvePod' | 'advertisedModels'> {
  const { pods } = deps
  const now = deps.now ?? (() => new Date())

  return {
    async resolvePod({ wait, client }): Promise<PodResolution> {
      // The token decides which pod this request may reach. With no target
      // there is nothing to route to, and choosing one here would rent
      // hardware on behalf of an application nobody assigned.
      const templateId = client.templateId
      if (!templateId) return { state: 'unassigned' }

      const active = pods.describeFor(templateId)
      if (active) {
        // A pod our records call RUNNING is not necessarily serving: RunPod
        // reports RUNNING minutes before the engine binds its port, and its
        // proxy answers 404 until something is listening. Forwarding into that
        // handed clients a bare 404 within a third of a second — the request
        // looked rejected when it had simply arrived too early.
        if (await pods.engineAnswers(templateId)) return { state: 'ready', pod: active }

        const waitSeconds = deps.wakeWaitSeconds()
        if (!wait || waitSeconds === 0) return { state: 'starting' }

        const record = pods.currentFor(templateId)
        const serving = record
          ? await pods.waitUntilServing(record.id, templateId, waitSeconds * 1000)
          : false
        const ready = serving ? pods.describeFor(templateId) : null
        return ready ? { state: 'ready', pod: ready } : { state: 'starting' }
      }

      // This client's own template, so a request arriving after the night
      // shutdown still wakes its pod — and only its pod. A local agent must
      // not be able to start the GPU that another application is paying for.
      const template = pods.template(templateId)
      if (!template) return { state: 'none' }

      // But not against that template's own schedule. Waking a pod the
      // schedule has just stopped makes the schedule meaningless and rents
      // hardware nobody agreed to: seen live, stopped at 21:30:19 and replaced
      // two seconds later by the next request from the same agent.
      const schedule = template.schedule
      if (schedule.enabled && schedule.startAt && schedule.stopAt && !isInsideWindow(schedule, now())) {
        return {
          state: 'outside-hours',
          window: `${schedule.startAt}–${schedule.stopAt} ${schedule.timezone}`,
        }
      }

      const waitSeconds = deps.wakeWaitSeconds()
      if (!wait || waitSeconds === 0) return { state: 'starting' }

      // Recorded as a client wake, not a person at the keyboard: the
      // manual-start exception must not apply here, or a woken pod would
      // outlive the schedule.
      const record = await pods.start(template, 'client')
      // Waits for the engine to answer, not just for RunPod to schedule the
      // container — those are minutes apart, and the gap is exactly where a
      // client would get a bare 404 from a port nothing is listening on.
      const serving = await pods.waitUntilServing(record.id, templateId, waitSeconds * 1000)
      const served = serving ? pods.describeFor(templateId) : null
      return served ? { state: 'ready', pod: served } : { state: 'starting' }
    },

    async advertisedModels(client: GatewayIdentity): Promise<AdvertisedModels> {
      const nothing: AdvertisedModels = { names: [], contextTokens: null }
      if (!client.templateId) return nothing

      const active = pods.describeFor(client.templateId)
      if (active) return { names: active.servedModels, contextTokens: active.contextTokens }

      // What this client's own template would serve while its pod sleeps.
      // Listing anything else shows an agent models it can never reach — and
      // listing nothing means it can never send the request that would wake
      // the pod, which is how an agent came to report "0 models" and stop.
      const template = pods.template(client.templateId)
      if (!template) return nothing
      return {
        names: [template.chatModel, template.embeddingModel]
          .filter((slot) => slot !== null)
          .map((slot) => slot.servedName ?? slot.repoId),
        // The window the pod will be started with, so a client that asks before
        // waking it is told the same figure it will get afterwards.
        contextTokens: template.maxModelLen ?? null,
      }
    },
  }
}
