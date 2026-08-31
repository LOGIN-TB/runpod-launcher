import { useEffect, useState, type ReactNode } from 'react'
import type { Template } from '@runpod-launcher/shared'
import {
  bytesToGib,
  estimateKvHeadroomGib,
  maxContextTokens,
  presetForFormat,
  suitableGpus,
  VLLM_PRESET,
} from '@runpod-launcher/shared'
import { api, type Connection, type GpuType, type ModelVerdict } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Button, Card, EmptyState, Field, Input } from '../components/primitives.js'
import { ModelPicker } from '../components/ModelPicker.js'
import { ScheduleEditor } from '../components/ScheduleEditor.js'
import { Confirm } from '../components/Confirm.js'

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
  // null = not editing; a template = editing that one; 'new' = creating.
  const [editing, setEditing] = useState<Template | 'new' | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Template | null>(null)

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
        existing={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null)
          onChanged()
        }}
        onCancel={() => setEditing(null)}
      />
    )
  }

  return (
    <div className="stack">
      <div className="row space-between">
        <h2>{t('template.title')}</h2>
        <Button variant="primary" onClick={() => setEditing('new')}>
          {t('template.new')}
        </Button>
      </div>

      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <Confirm
        open={pendingDelete !== null}
        title={t('action.delete')}
        body={t('template.deleteConfirm', { name: pendingDelete?.name ?? '' })}
        danger
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const template = pendingDelete
          setPendingDelete(null)
          if (template) void act(template.id, () => api.deleteTemplate(connection, template.id))
        }}
      />

      {templates.length === 0 ? (
        <Card>
          <EmptyState title={t('template.none')} hint={t('template.noneHint')} />
        </Card>
      ) : (
        templates.map((template) => (
          <Card key={template.id}>
            <div className="entry">
              <div className="entry-main">
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
              <div className="entry-actions">
                {/* This makes a new pod; it does not resume an existing one.
                    Calling it "Start" made people expect the latter. */}
                <Button
                  variant="primary"
                  loading={busy === template.id}
                  onClick={() => act(template.id, () => api.startPod(connection, template.id))}
                >
                  {t('template.createPod')}
                </Button>
                <Button variant="secondary" onClick={() => setEditing(template)}>
                  {t('action.edit')}
                </Button>
                <Button
                  variant="danger"
                  loading={busy === template.id}
                  onClick={() => setPendingDelete(template)}
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
  existing,
  onDone,
  onCancel,
}: {
  connection: Connection
  /** The template being edited, or null when creating one. */
  existing: Template | null
  onDone: () => void
  onCancel: () => void
}): ReactNode {
  const { t, money, number } = useI18n()
  const [gpus, setGpus] = useState<GpuType[]>([])
  const [name, setName] = useState(existing?.name ?? '')
  const [gpuId, setGpuId] = useState(existing?.gpuTypeId ?? '')
  // Chosen by hand when editing; computed automatically for a new template.
  const [fallbackOverride, setFallbackOverride] = useState<string[] | null>(
    existing ? existing.gpuFallbackIds : null,
  )
  const [chat, setChat] = useState<Slot>({
    repoId: existing?.chatModel?.repoId ?? '',
    verdict: null,
    quantisation: existing?.chatModel?.quantisation ?? null,
  })
  const [embedding, setEmbedding] = useState<Slot>({
    repoId: existing?.embeddingModel?.repoId ?? '',
    verdict: null,
    quantisation: existing?.embeddingModel?.quantisation ?? null,
  })
  const [useEmbedding, setUseEmbedding] = useState(existing?.embeddingModel != null)
  const [sleepMode, setSleepMode] = useState<Template['lifecycleMode']>(existing?.lifecycleMode ?? 'stopResume')
  const [advanced, setAdvanced] = useState(false)
  /**
   * The vLLM parsers, seeded from the chosen model's own chat template and
   * editable because detection reads a Jinja template and can be wrong. An
   * unusual model must not be unusable.
   */
  const [toolParser, setToolParser] = useState(existing?.toolCallParser ?? '')
  const [reasonParser, setReasonParser] = useState(existing?.reasoningParser ?? '')
  /**
   * Whether the parsers are the user's own, so detection never overwrites them.
   * Same reason as the context above: a saved override is a decision.
   */
  const [parsersTouched, setParsersTouched] = useState(
    existing?.toolCallParser != null || existing?.reasoningParser != null,
  )
  const [schedule, setSchedule] = useState<Template['schedule']>(existing?.schedule ?? {
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
  const [maxLen, setMaxLen] = useState(String(existing?.maxModelLen ?? ''))
  /**
   * Whether the context is the user's own figure, so the fitted value never
   * overwrites it.
   *
   * True from the start when editing a template that already has one: a value
   * somebody saved is a decision, and re-opening the form to look at it must
   * not silently change it.
   */
  const [maxLenTouched, setMaxLenTouched] = useState(existing?.maxModelLen !== undefined)
  const [maxSeqs, setMaxSeqs] = useState(String(existing?.maxConcurrentSequences ?? 64))
  // Whether the user has set the number themselves; until they do it follows
  // the engine, because the two spend memory very differently.
  const [seqsTouched, setSeqsTouched] = useState(existing !== null)
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
        .map((candidate) => candidate.id)
    : []

  // Suggested automatically, but the user has the final say — the launcher
  // tells people to add fallbacks when capacity runs out, so they must be able
  // to.
  const chosenFallbacks = fallbackOverride ?? fallbacks.slice(0, 3)

  /**
   * Concurrent requests, defaulted per engine.
   *
   * llama.cpp divides one context budget between slots, so 64 slots of a
   * 16k window would ask for a million tokens of cache — and in practice gave
   * each request 256 tokens. vLLM's limit is independent of the window.
   */
  const effectiveSeqs = seqsTouched ? maxSeqs : String(preset.defaultConcurrency)

  /**
   * How much context the card can actually hold, and whether the request fits.
   *
   * Nothing checked this before: a template asking for the model's native
   * 262,144-token window across four slots is a million tokens of cache, and
   * llama.cpp would have discovered that only after downloading 29 GB.
   */
  const contextBudget = ((): { fits: boolean; max: number; asked: number } | null => {
    if (!gpu || chatBytes === 0) return null
    const headroom = estimateKvHeadroomGib({
      gpuMemoryGib: gpu.memory,
      weightsGib: bytesToGib(chatBytes + embeddingBytes),
    })
    // Two ceilings, and the lower one wins. The card's memory is the usual
    // limit, but a model with a short window makes the engine refuse to start
    // at all — and that refusal arrives after the weights have downloaded.
    const native = chat.verdict?.details.nativeContextTokens ?? null
    const max = Math.min(maxContextTokens(headroom), native ?? Number.MAX_SAFE_INTEGER)
    // llama.cpp shares one budget between slots; vLLM's window is per request.
    const asked = preset.engine === 'llamacpp' ? Number(maxLen) * Number(effectiveSeqs) : Number(maxLen)
    return { fits: asked <= max, max, asked }
  })()

  const blocked =
    !name ||
    !gpu ||
    (!chat.repoId && !useEmbedding) ||
    (chat.repoId !== '' && chat.verdict?.compatible === false) ||
    (useEmbedding && embedding.verdict?.compatible === false) ||
    // A chat model with no context figure would render `--max-model-len` with
    // nothing after it, which swallows the next flag and fails the start with
    // something that reads like an unrelated problem.
    (chat.repoId !== '' && maxLen.trim() === '') ||
    contextBudget?.fits === false

  /**
   * The context starts at what actually fits on the card.
   *
   * It used to start at a flat 16384, which on a 48 GB card running FP8 weights
   * throws away about eight times the context the card can hold — and it is what
   * an agent then hits: `max_tokens=65536 cannot be greater than
   * max_model_len=16384`, which the agent read as its own context being full and
   * shut itself down over. The arithmetic for this was already here; it was only
   * ever used to reject a number, never to offer one.
   */
  useEffect(() => {
    if (maxLenTouched || !contextBudget) return
    const perRequest =
      preset.engine === 'llamacpp'
        ? Math.floor(contextBudget.max / Math.max(1, Number(effectiveSeqs)))
        : contextBudget.max
    // Rounded down to a round number, because an exact figure from an estimate
    // reads as a promise the estimate cannot keep.
    const rounded = Math.max(4096, Math.floor(perRequest / 1024) * 1024)
    setMaxLen(String(rounded))
  }, [maxLenTouched, contextBudget?.max, preset.engine, effectiveSeqs])

  // Detection fills the fields when a model is chosen, and stops the moment the
  // user edits them.
  const detected = chat.verdict?.details
  useEffect(() => {
    if (parsersTouched || !detected) return
    setToolParser(detected.toolCallParser ?? '')
    setReasonParser(detected.reasoningParser ?? '')
  }, [detected?.repoId, detected?.toolCallParser, detected?.reasoningParser, parsersTouched])

  /** llama.cpp reads the template out of the GGUF itself and takes no such flag. */
  const parsers =
    preset.engine === 'vllm'
      ? { toolCallParser: toolParser || null, reasoningParser: reasonParser || null }
      : { toolCallParser: null, reasoningParser: null }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const body = {
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
        gpuFallbackIds: chosenFallbacks,
        maxModelLen: Number(maxLen),
        maxConcurrentSequences: Number(effectiveSeqs),
        lifecycleMode: sleepMode,
        /**
         * Taken from the chat model's own template rather than from its name.
         *
         * vLLM rejects a request with `tool_choice: "auto"` outright unless it
         * was started with a parser, and the parser has to match the format the
         * model emits — Qwen3.8 emits XML where its own family's documentation
         * would suggest Hermes.
         */
        toolCallParser: parsers.toolCallParser,
        reasoningParser: parsers.reasoningParser,
        schedule,
        networkVolumeId: null,
        args: chat.repoId ? preset.chatArgs : preset.embeddingArgs,
      }
      await (existing
        ? api.updateTemplate(connection, existing.id, body)
        : api.createTemplate(connection, body))
      onDone()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card>
      <h2>{existing ? t('template.edit', { name: existing.name }) : t('template.new')}</h2>

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

      {/* Which other cards may stand in when the chosen one has no capacity.
          Only ones that are at least as large, run the same format and cost no
          more are offered — a substitute must not quietly be worse. */}
      {gpu && fallbacks.length > 0 ? (
        <Field label={t('template.fallbacks')} hint={t('template.fallbacksHint')}>
          <div className="stack">
            {fallbacks.slice(0, 6).map((id) => {
              const candidate = gpus.find((entry) => entry.id === id)
              const on = chosenFallbacks.includes(id)
              return (
                <label key={id} className="toggle">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(event) =>
                      setFallbackOverride(
                        event.target.checked
                          ? [...chosenFallbacks, id]
                          : chosenFallbacks.filter((entry) => entry !== id),
                      )
                    }
                  />
                  <span className="muted small">
                    {candidate?.name} · {candidate?.memory} GiB · {money(candidate?.price.secure ?? 0)}/h ·{' '}
                    {candidate?.availability ?? '?'}
                  </span>
                </label>
              )
            })}
          </div>
        </Field>
      ) : null}

      <ModelPicker
        connection={connection}
        kind="chat"
        engine={preset.engine}
        gpu={gpu}
        otherSlotBytes={embeddingBytes}
        value={chat.repoId}
        quantisation={existing?.chatModel?.quantisation ?? null}
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
          quantisation={existing?.embeddingModel?.quantisation ?? null}
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

      {contextBudget ? (
        <p className={contextBudget.fits ? 'muted small' : 'field-error'}>
          {contextBudget.fits
            ? t('template.contextFits', { max: number(contextBudget.max) })
            : t('template.contextTooLarge', {
                asked: number(contextBudget.asked),
                max: number(contextBudget.max),
              })}
        </p>
      ) : null}

      <h3>{t('schedule.title')}</h3>
      <ScheduleEditor schedule={schedule} timezone={schedule.timezone} onChange={setSchedule} />

      <button type="button" className="disclosure" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {t('template.advanced')}
      </button>

      {advanced ? (
        <div className="row">
          <Field
            label={t('template.contextLength')}
            hint={t('template.contextLengthHint')}
            {...(contextBudget && !contextBudget.fits
              ? {
                  error: t('template.contextTooLarge', {
                    asked: number(contextBudget.asked),
                    max: number(contextBudget.max),
                  }),
                }
              : {})}
          >
            <Input
              type="number"
              value={maxLen}
              onChange={(event) => {
                setMaxLenTouched(true)
                setMaxLen(event.target.value)
              }}
            />
          </Field>
          <Field label={t('template.concurrency')} hint={t(`template.concurrencyHint.${preset.engine}` as const)}>
            <Input
              type="number"
              value={effectiveSeqs}
              onChange={(event) => {
                setSeqsTouched(true)
                setMaxSeqs(event.target.value)
              }}
            />
          </Field>
        </div>
      ) : null}

      {advanced && preset.engine === 'vllm' ? (
        <>
          <div className="row">
            <Field label={t('template.toolParser')}>
              <Input
                value={toolParser}
                placeholder={t('template.parserNone')}
                onChange={(event) => {
                  setParsersTouched(true)
                  setToolParser(event.target.value.trim())
                }}
              />
            </Field>
            <Field label={t('template.reasoningParser')}>
              <Input
                value={reasonParser}
                placeholder={t('template.parserNone')}
                onChange={(event) => {
                  setParsersTouched(true)
                  setReasonParser(event.target.value.trim())
                }}
              />
            </Field>
          </div>
          <p className="muted small">{t('template.parserHint')}</p>
        </>
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
