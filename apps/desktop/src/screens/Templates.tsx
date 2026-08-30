import { useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import { api, type Connection, type GpuType, type ModelVerdict } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card, EmptyState, Field, Input } from '../components/primitives.js'
import { ModelPicker } from '../components/ModelPicker.js'

const DEFAULT_IMAGE = 'vllm/vllm-openai:v0.28.0'

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
                  {[template.chatModel?.repoId, template.embeddingModel?.repoId].filter(Boolean).join(' + ')}
                </p>
              </div>
              <div className="row">
                <Badge tone="neutral">{template.gpuTypeId}</Badge>
                <Badge tone={template.lifecycleMode === 'stopResume' ? 'running' : 'pending'}>
                  {template.lifecycleMode === 'stopResume'
                    ? t('template.sleepStopResume')
                    : t('template.sleepRecreate')}
                </Badge>
              </div>
            </div>
          </Card>
        ))
      )}
    </div>
  )
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
  const [chat, setChat] = useState<{ repoId: string; verdict: ModelVerdict | null }>({ repoId: '', verdict: null })
  const [embedding, setEmbedding] = useState<{ repoId: string; verdict: ModelVerdict | null }>({ repoId: '', verdict: null })
  const [useEmbedding, setUseEmbedding] = useState(false)
  const [sleepMode, setSleepMode] = useState<Template['lifecycleMode']>('stopResume')
  const [advanced, setAdvanced] = useState(false)
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
        engine: 'vllm',
        image: DEFAULT_IMAGE,
        chatModel: chat.repoId ? { repoId: chat.repoId } : null,
        embeddingModel: useEmbedding && embedding.repoId ? { repoId: embedding.repoId } : null,
        gpuTypeId: gpu!.id,
        gpuFallbackIds: gpus.slice(0, 4).map((candidate) => candidate.id).filter((id) => id !== gpu!.id),
        maxModelLen: Number(maxLen),
        maxConcurrentSequences: Number(maxSeqs),
        lifecycleMode: sleepMode,
        networkVolumeId: null,
        args:
          '{{chatModel}} --port 8000 --host 0.0.0.0 --api-key {{apiKey}} --max-model-len {{maxModelLen}}' +
          ' --gpu-memory-utilization {{chatGpuFraction}} --max-num-seqs {{maxConcurrentSequences}}',
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
        engine="vllm"
        gpu={gpu}
        otherSlotBytes={embeddingBytes}
        value={chat.repoId}
        onChange={(repoId, verdict) => setChat({ repoId, verdict })}
      />

      <label className="toggle">
        <input type="checkbox" checked={useEmbedding} onChange={(event) => setUseEmbedding(event.target.checked)} />
        <span>{t('template.embeddingModel')}</span>
      </label>

      {useEmbedding ? (
        <ModelPicker
          connection={connection}
          kind="embedding"
          engine="vllm"
          gpu={gpu}
          otherSlotBytes={chatBytes}
          value={embedding.repoId}
          onChange={(repoId, verdict) => setEmbedding({ repoId, verdict })}
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
