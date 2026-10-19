import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

// Small file logger. Secrets registered via registerSecret() are masked in every line,
// and anything that looks like an API key query parameter or bearer token is redacted.

type Level = 'debug' | 'info' | 'warn' | 'error'

const secrets = new Set<string>()
let logFile: string | undefined
const MAX_BYTES = 2 * 1024 * 1024

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value)
}

export function redact(text: string): string {
  let out = text
  for (const s of secrets) out = out.split(s).join('***')
  out = out.replace(/([?&](?:key|api_key|access_token)=)[^&\s"']+/gi, '$1***')
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***')
  return out
}

export function initLogger(dir: string): string {
  mkdirSync(dir, { recursive: true })
  logFile = path.join(dir, 'lumen.log')
  try {
    if (statSync(logFile).size > MAX_BYTES) renameSync(logFile, path.join(dir, 'lumen.old.log'))
  } catch {
    /* no previous log */
  }
  return logFile
}

function write(level: Level, scope: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${redact(msg)}`
  if (level === 'error' || level === 'warn') console.warn(line)
  else if (process.env.LUMEN_DEBUG) console.log(line)
  if (!logFile) return
  try {
    appendFileSync(logFile, line + '\n')
  } catch {
    /* logging must never crash the app */
  }
}

export const log = {
  debug: (scope: string, msg: string) => process.env.LUMEN_DEBUG && write('debug', scope, msg),
  info: (scope: string, msg: string) => write('info', scope, msg),
  warn: (scope: string, msg: string) => write('warn', scope, msg),
  error: (scope: string, msg: string, err?: unknown) =>
    write('error', scope, err ? `${msg}: ${err instanceof Error ? err.stack || err.message : String(err)}` : msg)
}
