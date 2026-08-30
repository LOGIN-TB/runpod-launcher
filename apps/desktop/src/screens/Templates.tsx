import { useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import { presetForFormat, suitableGpus, VLLM_PRESET } from '@runpod-launcher/shared'
import { api, type Connection, type GpuType, type ModelVerdict } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card, EmptyState, Field, Input } from '../components/primitives.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { ScheduleEditor } from '../components/ScheduleEditor.js'

export function Templates({
  connection,
  templates,
  onChanged,
}: {
  connection: Connection
  templates: Template[]
  onChanged: () => void
}): ReactNode {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const act = async (id: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      await fn()
      onChanged()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (editing) {
    return (
      <TemplateEditor
        connection={connection}
        onDone={() => {
          setEditing(false)
          onChanged()
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }

  return (
    <div className="stack">
      <div className="row space-between">
        <h2>{t('template.title')}</h2>
        <Button variant="primary" onClick={() => setEditing(true)}>
          {t('template.new')}
        </Button>
      </div>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      {templates.length === 0 ? (
        <Card>
          <EmptyState title={t('template.none')} hint={t('template.noneHint')} />
        </Card>
      ) : (
        templates.map((template) => (
          <Card key={template.id}>
            <div className="row space-between">
              <div>
                <strong>{template.name}</strong>
                <p className="muted small">
                  {[template.chatModel, template.embeddingModel]
                    .filter((slot) => slot !== null)
                    .map((slot) => (slot.quantisation ? `${slot.repoId}:${slot.quantisation}` : slot.repoId))
                    .join(' + ')}
                </p>
                <div className="row">
                  <Badge tone="neutral">{template.gpuTypeId}</Badge>
                  <Badge tone={template.lifecycleMode === 'stopResume' ? 'running' : 'pending'}>
                    {template.lifecycleMode === 'stopResume'
                      ? t('template.sleepStopResume')
                      : t('template.sleepRecreate')}
                  </Badge>
                  {template.schedule.enabled ? <Badge tone="neutral">{t('schedule.title')}</Badge> : null}
                </div>
              </div>

              {/* A list you can only look at is not a list of anything. */}
              <div className="pod-actions">
                <Button
                  variant="primary"
                  loading={busy === template.id}
                  onClick={() => act(template.id, () => api.startPod(connection, template.id))}
                >
                  {t('pod.start')}
                </Button>
                <Button
                  variant="danger"
                  loading={busy === template.id}
                  onClick={() => {
                    if (confirm(t('template.deleteConfirm', { name: template.name }))) {
                      void act(template.id, () => api.deleteTemplate(connection, template.id))
                    }
                  }}
                >
                  {t('action.delete')}
                </Button>
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  )
}

interface Slot {
  repoId: string
  verdict: ModelVerdict | null
  /** Which GGUF build, when the repository offers several. */
  quantisation: string | null
}

/**
 * The editor shows five fields and hides the rest.
 *
 * Someone setting this up for the first time should not have to form an opinion
 * about VRAM fractions; someone who has one can open Advanced and set it.
 */
function TemplateEditor({
  connection,
  onDone,
  onCancel,
}: {
  connection: Connection
  onDone: () => void
  onCancel: () => void
}): ReactNode {
  const { t, money } = useI18n()
  const [gpus, setGpus] = useState<GpuType[]>([])
  const [name, setName] = useState('')
  const [gpuId, setGpuId] = useState('')
  const [chat, setChat] = useState<Slot>({ repoId: '', verdict: null, quantisation: null })
  const [embedding, setEmbedding] = useState<Slot>({ repoId: '', verdict: null, quantisation: null })
  const [useEmbedding, setUseEmbedding] = useState(false)
  const [sleepMode, setSleepMode] = useState<Template['lifecycleMode']>('stopResume')
  const [advanced, setAdvanced] = useState(false)
  const [schedule, setSchedule] = useState<Template['schedule']>({
    enabled: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    weekdays: [1, 2, 3, 4, 5],
    startAt: '07:00',
    stopAt: '19:00',
    // A pod that nobody has called for half an hour is the single biggest
    // saving available, so it is on by default.
    idleStopMinutes: 30,
    maxRuntimeHours: 12,
  })
  const [maxLen, setMaxLen] = useState('16384')
  const [maxSeqs, setMaxSeqs] = useState('64')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.gpus(connection).then((result) => {
      // Availability first, then price: a cheaper card that cannot be had is
      // not cheaper. Capacity for 48 GB cards is thin and moves within minutes.
      const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as Record<string, number>
      setGpus(
        result.gpus
          .filter((gpu) => gpu.memory >= 16)
          .sort(
            (a, b) =>
              (rank[a.availability ?? 'LOW'] ?? 3) - (rank[b.availability ?? 'LOW'] ?? 3) ||
              (a.price.secure ?? 99) - (b.price.secure ?? 99),
          ),
      )
    })
  }, [connection])

  const gpu = gpus.find((candidate) => candidate.id === gpuId) ?? null
  const chatBytes = chat.verdict?.details.weightBytes ?? 0
  const embeddingBytes = useEmbedding ? (embedding.verdict?.details.weightBytes ?? 0) : 0

  // The engine follows from the weights, it is not a separate choice. A GGUF
  // build only runs under llama.cpp; everything else under vLLM.
  const format = (chat.verdict?.details.format ?? embedding.verdict?.details.format ?? 'unknown') as
    Parameters<typeof presetForFormat>[0]
  const preset = presetForFormat(format) ?? VLLM_PRESET

  /**
   * Fallback cards, restricted to ones that can actually hold the model.
   *
   * Choosing these by price alone is how a template asking for a 96 GiB card
   * ended up on a 48 GiB one: the fallback quietly undid the compatibility
   * check that had just passed on the primary choice.
   */
  const fallbacks = gpu
    ? suitableGpus(
        gpus.filter((candidate) => candidate.id !== gpu.id && candidate.memory >= gpu.memory),
        {
          format,
          weightsGib: (chatBytes + embeddingBytes) / 1024 ** 3,
          // Never more than the card that was chosen: a substitute should not
          // cost more than the original.
          maxPricePerHour: gpu.price.secure,
        },
      )
        .sort((a, b) => (a.price.secure ?? 99) - (b.price.secure ?? 99))
        .slice(0, 3)
        .map((candidate) => candidate.id)
    : []

  const blocked =
    !name ||
    !gpu ||
    (!chat.repoId && !useEmbedding) ||
    (chat.repoId !== '' && chat.verdict?.compatible === false) ||
    (useEmbedding && embedding.verdict?.compatible === false)

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await api.createTemplate(connection, {
        name,
        engine: preset.engine,
        image: preset.image,
        chatModel: chat.repoId
          ? { repoId: chat.repoId, ...(chat.quantisation ? { quantisation: chat.quantisation } : {}) }
          : null,
        embeddingModel:
          useEmbedding && embedding.repoId
            ? {
                repoId: embedding.repoId,
                ...(embedding.quantisation ? { quantisation: embedding.quantisation } : {}),
              }
            : null,
        gpuTypeId: gpu!.id,
        gpuFallbackIds: fallbacks,
        maxModelLen: Number(maxLen),
        maxConcurrentSequences: Number(maxSeqs),
        lifecycleMode: sleepMode,
        schedule,
        networkVolumeId: null,
        args: chat.repoId ? preset.chatArgs : preset.embeddingArgs,
      })
      onDone()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <h2>{t('template.new')}</h2>

      <Field label={t('template.name')}>
        <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="qwen-chat" />
      </Field>

      <Field label={t('template.gpu')}>
        <select className="input" value={gpuId} onChange={(event) => setGpuId(event.target.value)}>
          <option value="">—</option>
          {gpus.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name} · {candidate.memory} GiB · {money(candidate.price.secure ?? 0)}/h ·{' '}
              {candidate.availability ?? '?'}
            </option>
          ))}
        </select>
      </Field>

      <ModelPicker
        connection={connection}
        kind="chat"
        engine={preset.engine}
        gpu={gpu}
        otherSlotBytes={embeddingBytes}
        value={chat.repoId}
        onChange={(repoId, verdict, quantisation) => setChat({ repoId, verdict, quantisation })}
      />

      <label className="toggle">
        <input type="checkbox" checked={useEmbedding} onChange={(event) => setUseEmbedding(event.target.checked)} />
        <span>{t('template.embeddingModel')}</span>
      </label>

      {useEmbedding ? (
        <ModelPicker
          connection={connection}
          kind="embedding"
          engine={preset.engine}
          gpu={gpu}
          otherSlotBytes={chatBytes}
          value={embedding.repoId}
          onChange={(repoId, verdict, quantisation) => setEmbedding({ repoId, verdict, quantisation })}
        />
      ) : null}

      <Field label={t('template.sleepMode')}>
        <div className="stack">
          <label className="choice">
            <input
              type="radio"
              checked={sleepMode === 'stopResume'}
              onChange={() => setSleepMode('stopResume')}
            />
            <span>
              <strong>{t('template.sleepStopResume')}</strong>
              <span className="muted small">{t('template.sleepStopResumeHint')}</span>
            </span>
          </label>
          <label className="choice">
            <input type="radio" checked={sleepMode === 'recreate'} onChange={() => setSleepMode('recreate')} />
            <span>
              <strong>{t('template.sleepRecreate')}</strong>
              <span className="muted small">{t('template.sleepRecreateHint')}</span>
            </span>
          </label>
        </div>
      </Field>

      {/* The engine is derived, not chosen — but it is shown, because it
          decides which quantisations are usable at all. */}
      {chat.verdict || embedding.verdict ? (
        <p className="muted small engine-note">{preset.note}</p>
      ) : null}

      <h3>{t('schedule.title')}</h3>
      <ScheduleEditor schedule={schedule} timezone={schedule.timezone} onChange={setSchedule} />

      <button type="button" className="disclosure" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {t('template.advanced')}
      </button>

      {advanced ? (
        <div className="row">
          <Field label={t('template.contextLength')}>
            <Input type="number" value={maxLen} onChange={(event) => setMaxLen(event.target.value)} />
          </Field>
          <Field
            label="max-num-seqs"
            hint="Hybrid-attention models need one cache block per concurrent request; vLLM's default of 256 does not always fit."
          >
            <Input type="number" value={maxSeqs} onChange={(event) => setMaxSeqs(event.target.value)} />
          </Field>
        </div>
      ) : null}

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="row">
        <Button variant="primary" loading={saving} disabled={blocked} onClick={save}>
          {t('action.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>
    </Card>
  )
}
