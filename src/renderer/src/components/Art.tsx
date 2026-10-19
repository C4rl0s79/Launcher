import { memo, useEffect, useState } from 'react'
import type { ArtKind } from '@shared/types'
import { api, useStore } from '../store'
import { hueOf } from '../lib/format'

interface Props {
  gameId: string
  name: string
  kind: ArtKind
  className?: string
  /** what to render when there is no image */
  fallback?: 'poster' | 'hero' | 'title' | 'none'
  eager?: boolean
  onState?: (ok: boolean) => void
}

/** Image served by the main process (lumen-art://) with a tasteful generated placeholder. */
export const Art = memo(function Art({ gameId, name, kind, className, fallback = 'poster', eager, onState }: Props) {
  const rev = useStore((s) => s.artRev[gameId] ?? 0)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const src = api().art.url(gameId, kind, rev)

  useEffect(() => setState('loading'), [src])

  const hue = hueOf(name)
  if (state === 'error') {
    if (fallback === 'none') return null
    if (fallback === 'title') return <div className={`art-title ${className ?? ''}`}>{name}</div>
    return (
      <div
        className={`art-placeholder art-placeholder--${fallback} ${className ?? ''}`}
        style={{ ['--h' as string]: hue }}
        aria-label={name}
      >
        {fallback === 'poster' && <span>{name}</span>}
      </div>
    )
  }
  return (
    <img
      key={src}
      className={`art art--${kind} ${state === 'ok' ? 'is-loaded' : ''} ${className ?? ''}`}
      src={src}
      alt=""
      draggable={false}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      style={state === 'loading' ? { ['--h' as string]: hue } : undefined}
      onLoad={() => {
        setState('ok')
        onState?.(true)
      }}
      onError={() => {
        setState('error')
        onState?.(false)
      }}
    />
  )
})
