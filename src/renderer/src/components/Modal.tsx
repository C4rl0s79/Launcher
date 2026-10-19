import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { focusFirst, focusEl } from '../nav/engine'
import { useActions, type Handlers, type Hint } from '../nav/input'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  handlers?: Handlers
  hints?: Hint[]
  className?: string
}

/** Focus-trapping dialog. Restores focus to the opener when closed. */
export function Modal({ title, onClose, children, wide, handlers, hints, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null)

  useActions(
    {
      back: () => {
        onClose()
        return true
      },
      ...handlers
    },
    { modal: true, hints: hints ?? [{ action: 'confirm', label: 'Wybierz' }, { action: 'back', label: 'Zamknij' }] }
  )

  useEffect(() => {
    if (ref.current) focusFirst(ref.current)
    const o = opener.current
    return () => {
      // restore focus once the layer is gone
      setTimeout(() => {
        // (React StrictMode simulates an unmount while the dialog stays in the DOM — ignore that)
        if (o && o.isConnected && !ref.current?.isConnected) focusEl(o, false)
      }, 0)
    }
  }, [])

  return createPortal(
    <div className="modal-backdrop" data-layer onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'modal--wide' : ''} ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="modal__title">{title}</h2>
        {children}
      </div>
    </div>,
    document.body
  )
}
