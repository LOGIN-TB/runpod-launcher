import { useEffect, useRef, type ReactNode } from 'react'
import { useI18n } from '../lib/i18n.js'
import { Button } from './primitives.js'

/**
 * A confirmation the user can actually see.
 *
 * `window.confirm` is not available here: a Tauri webview leaves the native
 * dialog delegates unimplemented, so the call returns false without showing
 * anything. Every delete button in the app silently did nothing, which read as
 * the feature being broken rather than the dialog being absent.
 */
export function Confirm({
  open,
  title,
  body,
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  body: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): ReactNode {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) element.showModal()
    if (!open && element.open) element.close()
  }, [open])

  const { t } = useI18n()

  return (
    <dialog
      ref={dialog}
      className="confirm"
      // Escape and the backdrop both mean no, as in every other dialog.
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
      onClick={(event) => {
        if (event.target === dialog.current) onCancel()
      }}
    >
      <h3>{title}</h3>
      <p className="muted">{body}</p>
      <div className="row">
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
          {danger ? t('action.delete') : t('action.save')}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t('action.cancel')}
        </Button>
      </div>
    </dialog>
  )
}
