import { useEffect, useRef, useState } from 'react'
import { Modal } from './Modal'

// Text input that works from the couch: with a controller, pressing A opens an on-screen
// keyboard; with a physical keyboard the field is typed into directly.

interface Props {
  value: string
  onChange: (v: string) => void
  onSubmit?: (v: string) => void
  placeholder?: string
  label: string
  type?: 'text' | 'password'
  className?: string
  autoFocus?: boolean
  inputRef?: React.RefObject<HTMLInputElement | null>
  navKey?: string
}

export function TextField({ value, onChange, onSubmit, placeholder, label, type = 'text', className, inputRef, navKey }: Props) {
  const own = useRef<HTMLInputElement>(null)
  const ref = inputRef ?? own
  const [osk, setOsk] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const open = (): void => setOsk(true)
    el.addEventListener('lumen-osk', open)
    return () => el.removeEventListener('lumen-osk', open)
  }, [ref])

  return (
    <>
      <input
        ref={ref}
        className={`field ${className ?? ''}`}
        data-nav
        data-key={navKey}
        type={type}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit?.(value)
          }
        }}
      />
      {osk && (
        <OnScreenKeyboard
          label={label}
          initial={value}
          secret={type === 'password'}
          onChange={onChange}
          onClose={(submit, v) => {
            setOsk(false)
            if (submit) onSubmit?.(v)
          }}
        />
      )}
    </>
  )
}

const ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', '-'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', ':'],
  ['ą', 'ć', 'ę', 'ł', 'ń', 'ó', 'ś', 'ź', 'ż', "'"]
]

function OnScreenKeyboard({
  label,
  initial,
  secret,
  onChange,
  onClose
}: {
  label: string
  initial: string
  secret: boolean
  onChange: (v: string) => void
  onClose: (submit: boolean, v: string) => void
}) {
  const [text, setText] = useState(initial)
  const [shift, setShift] = useState(false)
  const update = (v: string): void => {
    setText(v)
    onChange(v)
  }
  const type = (k: string): void => {
    update(text + (shift ? k.toLocaleUpperCase('pl') : k))
    if (shift) setShift(false)
  }
  const backspace = (): boolean => {
    update(text.slice(0, -1))
    return true
  }

  // physical keys also work while the OSK is open
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const isChar = e.key.length === 1 && !e.ctrlKey && !e.altKey && e.key !== ' '
      if (!isChar && e.key !== 'Backspace') return
      e.stopImmediatePropagation()
      e.preventDefault()
      setText((t) => {
        const v = e.key === 'Backspace' ? t.slice(0, -1) : t + e.key
        onChange(v)
        return v
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onChange])

  return (
    <Modal
      title={label}
      onClose={() => onClose(false, text)}
      className="osk"
      handlers={{
        x: backspace,
        y: () => {
          type(' ')
          return true
        },
        lb: () => {
          setShift((s) => !s)
          return true
        },
        menu: () => {
          onClose(true, text)
          return true
        }
      }}
      hints={[
        { action: 'confirm', label: 'Wpisz' },
        { action: 'x', label: 'Usuń' },
        { action: 'y', label: 'Spacja' },
        { action: 'lb', label: 'Wielkie litery' },
        { action: 'menu', label: 'Gotowe' },
        { action: 'back', label: 'Zamknij' }
      ]}
    >
      <div className="osk__display">{secret ? '•'.repeat(text.length) : text}<span className="osk__caret" /></div>
      <div className="osk__keys">
        {ROWS.map((row, r) => (
          <div className="osk__row" key={r}>
            {row.map((k, i) => (
              <button key={k} className="osk__key" data-nav data-autofocus={r === 1 && i === 0 ? true : undefined} onClick={() => type(k)}>
                {shift ? k.toLocaleUpperCase('pl') : k}
              </button>
            ))}
          </div>
        ))}
        <div className="osk__row">
          <button className={`osk__key osk__key--wide ${shift ? 'is-on' : ''}`} data-nav onClick={() => setShift((s) => !s)}>
            ⇧ Shift
          </button>
          <button className="osk__key osk__key--space" data-nav onClick={() => type(' ')}>
            Spacja
          </button>
          <button className="osk__key osk__key--wide" data-nav onClick={backspace}>
            ⌫ Usuń
          </button>
          <button className="osk__key osk__key--wide" data-nav onClick={() => update('')}>
            Wyczyść
          </button>
          <button className="osk__key osk__key--wide osk__key--done" data-nav onClick={() => onClose(true, text)}>
            Gotowe
          </button>
        </div>
      </div>
    </Modal>
  )
}
