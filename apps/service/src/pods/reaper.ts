import type { Db } from '../store/db.js'
import type { PodManager } from './manager.js'

/**
 * Terminates pods this launcher created and no longer needs.
 *
 * Pods used to accumulate one per cycle: the schedule stopped one, the next
 * start built another, and nothing ever removed the first. Three pods for a
 * single template after one evening — indistinguishable from each other in the
 * list, and billing for their disks if the template uses a volume.
 *
 * Reconciled against RunPod's own list rather than against our records, because
 * the records are the thing that can be wrong. A pod we believe gone but RunPod
 * still holds is exactly the pile-up this is meant to clear, and no amount of
 * reading our own table would find it.
 *
 * Only pods with a record in our `pods` table are touched. Anything else the
 * user runs on RunPod is not this launcher's business, and the pod name is not
 * a safe signal.
 */
export interface ReapResult {
  terminated: string[]
  kept: string[]
}

export async function reapSupersededPods(
  db: Db,
  pods: PodManager,
  log: (message: string, detail: Record<string, unknown>) => void,
): Promise<ReapResult> {
  const live = await pods.listLiveIds()
  if (live === null) return { terminated: [], kept: [] }

  const ours = db.prepare('SELECT id, template_id AS templateId FROM pods WHERE template_id IS NOT NULL').all() as Array<{
    id: string
    templateId: string
  }>

  // Every running pod, not just the newest one. While only one pod ever ran
  // those were the same set; with one pod per application they are not, and
  // protecting only the newest would have this terminate a pod that is serving
  // somebody's requests right now.
  const running = new Set(pods.runningPods().map((pod) => pod.id))
  const terminated: string[] = []
  const kept: string[] = []

  for (const record of ours) {
    // Already gone at RunPod: nothing to do, whatever our table says.
    if (!live.has(record.id)) continue

    if (running.has(record.id)) {
      kept.push(record.id)
      continue
    }

    // One paused pod per template is kept on purpose: that is the pod a resume
    // would wake, and discarding it would throw away a downloaded model and
    // turn every start into a ten-minute wait.
    if (pods.resumable(record.templateId)?.id === record.id) {
      kept.push(record.id)
      continue
    }

    try {
      await pods.act(record.id, 'terminate', 'superseded')
      // Written to the audit log so the pod does not simply vanish from the
      // list with no explanation. "Where did my pod go" is exactly the question
      // the log exists to answer.
      db.prepare('INSERT INTO audit_log (at, actor, action, detail, ip) VALUES (?, ?, ?, ?, ?)').run(
        new Date().toISOString(),
        'scheduler',
        'pod.terminate',
        JSON.stringify({ podId: record.id, reason: 'superseded' }),
        null,
      )
      terminated.push(record.id)
    } catch (error) {
      // Retried on the next pass. A failure here must never stop the service
      // from starting.
      log('could not terminate a superseded pod', { pod: record.id, error: (error as Error).message })
    }
  }

  if (terminated.length > 0) log('terminated superseded pods', { pods: terminated })
  return { terminated, kept }
}
