// Minimal parser for Valve's text KeyValues format (.vdf / .acf).
// Supports quoted and unquoted tokens, escapes, // comments, nested objects and
// "#include"/"#base" directives (ignored). Duplicate keys: last value wins,
// except that objects with the same key are merged.

export type VdfValue = string | VdfObject
export interface VdfObject {
  [key: string]: VdfValue
}

export class VdfParseError extends Error {}

export function parseVdf(text: string): VdfObject {
  let i = 0
  const n = text.length
  if (text.charCodeAt(0) === 0xfeff) i = 1

  function skipWs(): void {
    while (i < n) {
      const c = text[i]
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        i++
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++
      } else {
        break
      }
    }
  }

  function readToken(): string | null {
    skipWs()
    if (i >= n) return null
    const c = text[i]
    if (c === '{' || c === '}') {
      i++
      return c
    }
    if (c === '"') {
      i++
      let out = ''
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1]
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e
          i += 2
        } else {
          out += text[i++]
        }
      }
      if (i >= n) throw new VdfParseError('Unterminated string')
      i++
      return '\u0000' + out // marker: quoted string (lets us tell "{" from {)
    }
    let out = ''
    while (i < n && !/[\s{}"]/.test(text[i])) out += text[i++]
    return '\u0000' + out
  }

  function parseObject(nested: boolean): VdfObject {
    const obj: VdfObject = {}
    for (;;) {
      const tok = readToken()
      if (tok === null) {
        if (nested) throw new VdfParseError('Unexpected end of input')
        return obj
      }
      if (tok === '}') {
        if (!nested) throw new VdfParseError('Unexpected }')
        return obj
      }
      if (tok === '{') throw new VdfParseError('Unexpected {')
      const key = tok.slice(1)
      const val = readToken()
      if (val === null) throw new VdfParseError(`Missing value for key "${key}"`)
      if (val === '}') throw new VdfParseError(`Missing value for key "${key}"`)
      if (key.startsWith('#')) {
        // #include / #base directives — skip value
        continue
      }
      // Optional conditional like [$WIN32] after value
      skipWs()
      if (text[i] === '[') {
        while (i < n && text[i] !== ']') i++
        i++
      }
      if (val === '{') {
        const child = parseObject(true)
        const prev = obj[key]
        obj[key] = prev && typeof prev === 'object' ? { ...prev, ...child } : child
      } else {
        obj[key] = val.slice(1)
      }
    }
  }

  return parseObject(false)
}

/** Case-insensitive lookup — Steam is inconsistent about key casing (e.g. "apps" vs "Apps"). */
export function vget(obj: VdfValue | undefined, ...path: string[]): VdfValue | undefined {
  let cur: VdfValue | undefined = obj
  for (const p of path) {
    if (!cur || typeof cur !== 'object') return undefined
    if (p in cur) {
      cur = cur[p]
      continue
    }
    const lower = p.toLowerCase()
    const k = Object.keys(cur).find((x) => x.toLowerCase() === lower)
    cur = k === undefined ? undefined : cur[k]
  }
  return cur
}

export function vstr(obj: VdfValue | undefined, ...path: string[]): string | undefined {
  const v = vget(obj, ...path)
  return typeof v === 'string' ? v : undefined
}

export function vobj(obj: VdfValue | undefined, ...path: string[]): VdfObject | undefined {
  const v = vget(obj, ...path)
  return v && typeof v === 'object' ? v : undefined
}

export function vnum(obj: VdfValue | undefined, ...path: string[]): number | undefined {
  const s = vstr(obj, ...path)
  if (s === undefined || s === '') return undefined
  const v = Number(s)
  return Number.isFinite(v) ? v : undefined
}
