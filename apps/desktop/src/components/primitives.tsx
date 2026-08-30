import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/**
 * The small set of building blocks every screen uses.
 *
 * Kept deliberately few. Each new variant is a decision that has to be repeated
 * consistently everywhere, and a tool this size does not need many.
 */

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'

export function Button({
  variant = 'secondary',
  loading = false,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean }): ReactNode {
  return (
    <button
      {...props}
      className={`btn btn-${variant}`}
      disabled={props.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {/* The hint sits under the control, where it is read after the label but
          before the value is committed. */}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  )
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return <input {...props} className="input" />
}

export function Card({ children, ...rest }: { children: ReactNode } & { className?: string }): ReactNode {
  return <section className={`card ${rest.className ?? ''}`}>{children}</section>
}

/** Status pill. `tone` maps to the state colours, not to arbitrary hues. */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'running' | 'stopped' | 'pending' | 'danger' | 'neutral'
  children: ReactNode
}): ReactNode {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

/**
 * What to show where nothing exists yet.
 *
 * Never just "no items": an empty screen is the moment someone most needs to
 * know what to do next, so the way forward is part of the component.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p className="muted">{hint}</p>
      {action}
    </div>
  )
}
