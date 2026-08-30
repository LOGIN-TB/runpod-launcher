import { useEffect, useState, type ReactNode } from 'react'
import { api, type Connection, type GpuType, type ModelHit, type ModelVerdict } from '../lib/api.js'
import { useI18n } from '../lib/i18n.js'
import { Badge, Field, Input } from './primitives.js'
import { describeProblem } from '../lib/problems.js'

const DEBOUNCE_MS = 350

/**
 * Picks a model for one slot and says, before anything is rented, whether it
 * will actually run on the chosen card.
 *
 * The verdict is the point. Weight format against engine, format against GPU,
 * and size against VRAM are each a way for a choice to fail four minutes into a
 * download that is already being billed.
 */
export function ModelPicker({
  connection,
  kind,
  engine,
  gpu,
  otherSlotBytes,
  value,
  onChange,
}: {
  connection: Connection
  kind: 'chat' | 'embedding'
  engine: 'vllm' | 'llamacpp'
  gpu: GpuType | null
  otherSlotBytes: number
  value: string
  onChange: (repoId: string, verdict: ModelVerdict | null, quantisation: string | null) => void
}): ReactNode {
  const { t, number } = useI18n()
  const [query, setQuery] = useState(value)
  const [hits, setHits] = useState<ModelHit[]>([])
  const [verdict, setVerdict] = useState<ModelVerdict | null>(null)
  const [checking, setChecking] = useState(false)
  // Which build of a GGUF repository to load. Null until one is offered.
  const [variant, setVariant] = useState<string | null>(null)

  // A repository id is recognisable on sight, so pasting one skips the search
  // entirely and goes straight to the compatibility check.
  const looksLikeRepoId = /^[\w.-]+\/[\w.-]+$/.test(query.trim())

  useEffect(() => {
    if (!query.trim() || looksLikeRepoId) {
      setHits([])
      return
    }
    const timer = setTimeout(() => {
      void api
        .searchModels(connection, query.trim(), kind)
        .then((result) => setHits(result.models))
        .catch(() => setHits([]))
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, kind, connection, looksLikeRepoId])

  useEffect(() => {
    if (!looksLikeRepoId || !gpu) {
      setVerdict(null)
      return
    }
    let cancelled = false
    setChecking(true)
    const timer = setTimeout(() => {
      void api
        .evaluateModel(connection, {
          repoId: query.trim(),
          kind,
          engine,
          gpuDisplayName: gpu.id,
          gpuMemoryGb: gpu.memory,
          otherSlotBytes,
          ...(variant ? { variant } : {}),
        })
        .then((result) => {
          if (cancelled) return
          setVerdict(result)
          // Adopt the default the service picked, so the dropdown shows what
          // was actually sized rather than an empty selection.
          const chosen = variant ?? defaultVariantOf(result)
          if (chosen !== variant) setVariant(chosen)
          onChange(query.trim(), result, chosen)
        })
        .catch(() => {
          if (!cancelled) setVerdict(null)
        })
        .finally(() => {
          if (!cancelled) setChecking(false)
        })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `onChange` is intentionally excluded: it is a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, kind, engine, gpu, otherSlotBytes, connection, looksLikeRepoId, variant])

  const gib = (bytes: number): string => `${number(bytes / 1024 ** 3, { maximumFractionDigits: 1 })} GiB`


  return (
    <div className="model-picker">
      <Field label={kind === 'chat' ? t('template.chatModel') : t('template.embeddingModel')} hint={t('model.searchHint')}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('model.search')}
          spellCheck={false}
        />
      </Field>

      {hits.length > 0 ? (
        <ul className="model-results">
          {hits.slice(0, 10).map((hit) => (
            <li key={hit.repoId}>
              <button type="button" onClick={() => setQuery(hit.repoId)}>
                <code>{hit.repoId}</code>
                <span className="hit-meta">
                  {/* The format decides which engine runs, and whether the
                      model fits at all. Hiding it until after the choice is
                      what made every result look interchangeable. */}
                  <Badge tone={hit.engine ? 'neutral' : 'danger'}>{hit.format.toUpperCase()}</Badge>
                  <span className="muted small">
                    {t('model.downloads', { count: number(hit.downloads, { notation: 'compact' }) })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {/* A GGUF repository is a set of alternatives, not one model: the same
          weights at a dozen precisions, and often several builds at each. Which
          one is loaded decides both the size and the quality, so it has to be a
          choice rather than a guess. */}
      {verdict?.details.ggufVariants && verdict.details.ggufVariants.length > 1 ? (
        <Field label={t('model.gguf.pick')} hint={t('model.gguf.pickHint')}>
          <select
            className="input"
            value={variant ?? ''}
            onChange={(event) => setVariant(event.target.value)}
          >
            {verdict.details.ggufVariants
              .slice()
              .sort((a, b) => b.bytes - a.bytes)
              .map((option) => (
                <option key={option.variant} value={option.variant}>
                  {option.label}
                  {option.qualifier ? ` (${option.qualifier})` : ''} — {gib(option.bytes)}
                </option>
              ))}
          </select>
        </Field>
      ) : null}

      {checking ? <p className="muted small">{t('model.checking')}</p> : null}

      {verdict && !checking ? (
        <div className={verdict.compatible ? 'verdict verdict-ok' : 'verdict verdict-bad'}>
          <Badge tone={verdict.compatible ? 'running' : 'danger'}>
            {verdict.details.format.toUpperCase()}
          </Badge>
          {verdict.compatible ? (
            <p>
              {t('model.fits', {
                weights: gib(verdict.details.weightBytes),
                headroom: gib((verdict.headroomGib ?? 0) * 1024 ** 3),
              })}
            </p>
          ) : (
            <div>
              <strong>{t('model.wontFit')}</strong>
              <ul>
                {verdict.problems.map((problem) => (
                  <li key={problem.code}>{describeProblem(problem, t, number)}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** The build the service sized, so the dropdown starts on the right one. */
function defaultVariantOf(verdict: ModelVerdict): string | null {
  const variants = verdict.details.ggufVariants
  if (!variants?.length) return null
  return variants.find((candidate) => candidate.bytes === verdict.details.weightBytes)?.variant ?? null
}
