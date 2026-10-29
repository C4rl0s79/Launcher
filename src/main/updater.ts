import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import yauzl from 'yauzl'
import type { UpdateFlavor, UpdateInfo, UpdateState } from '@shared/types'
import { log } from './logger'
import { verifyRelease } from './releaseSigning'

// Self-update from GitHub releases, the way EmuStart does it (emustart/updater.py):
//  1. check the latest release of C4rl0s79/Launcher and pick the file for this build
//     (zip = folder version, setup = installed, portable = single exe),
//  2. download it into LumenData\update with progress, check the size, GitHub's SHA-256 and the
//     Ed25519 release signature (<file>.sig, releaseSigning.ts) — nothing is used without them,
//  3. zip: unpack with path checks into update\new,
//  4. apply: a PowerShell script outside this process waits for Lumen (and the engine) to close,
//     backs the program up, swaps the files (LumenData is never touched), restores the backup on
//     failure and starts Lumen again. Log: LumenData\logs\update.log.

export const REPO = 'C4rl0s79/Launcher'
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`

export function vtuple(v: string): number[] {
  return (v.match(/\d+/g) ?? []).slice(0, 4).map(Number)
}

export function isNewer(latest: string, current: string): boolean {
  const a = vtuple(latest)
  const b = vtuple(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d) return d > 0
  }
  return false
}

/** Which kind of build is running (what to download and how to swap it). */
export function detectFlavor(o: { packaged: boolean; exeDir: string; portableFile?: string; exists?: (p: string) => boolean }): UpdateFlavor {
  if (!o.packaged) return 'dev'
  if (o.portableFile) return 'portable'
  const exists = o.exists ?? existsSync
  return exists(path.join(o.exeDir, 'Uninstall Lumen.exe')) ? 'installed' : 'zip'
}

export const ASSET_RE: Record<Exclude<UpdateFlavor, 'dev'>, RegExp> = {
  zip: /^Lumen-[\d.]+-(portable|win64)\.zip$/, // „-portable.zip” od 1.0.20
  installed: /^Lumen-[\d.]+-setup\.exe$/,
  portable: /^Lumen-[\d.]+-portable\.exe$/ // do 1.0.19 — potem bez pliku (przejście na ZIP ręcznie)
}

interface GhAsset {
  name: string
  size: number
  browser_download_url: string
  digest?: string
}

/** GitHub "latest release" JSON → what this build would download. */
export function readRelease(rel: { tag_name?: string; body?: string; html_url?: string; published_at?: string; assets?: GhAsset[] }, flavor: UpdateFlavor, current: string): UpdateInfo {
  const version = (rel.tag_name ?? '').replace(/^v/, '')
  const assets = rel.assets ?? []
  const asset = flavor === 'dev' ? undefined : assets.find((a) => ASSET_RE[flavor].test(a.name))
  const sig = asset ? assets.find((a) => a.name === `${asset.name}.sig`) : undefined
  return {
    version,
    current,
    newer: isNewer(version, current),
    flavor,
    file: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: (asset.digest ?? '').replace(/^sha256:/, '').toLowerCase() } : undefined,
    sigUrl: sig?.browser_download_url,
    notes: (rel.body ?? '').slice(0, 4000),
    page: rel.html_url ?? '',
    published: rel.published_at ?? ''
  }
}

/** Unpack the folder version with checks: Lumen.exe and resources\app.asar present, no path outside `dest`. */
export async function extractZip(zipFile: string, dest: string): Promise<void> {
  // Electron treats any *.asar path as an archive; the update's resourcespp.asar is a plain file here
  const proc = process as NodeJS.Process & { noAsar?: boolean }
  const before = proc.noAsar
  proc.noAsar = true
  try {
    await unzip(zipFile, dest)
  } finally {
    proc.noAsar = before
  }
}

function unzip(zipFile: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('Nie można otworzyć archiwum.'))
      const base = path.resolve(dest)
      const seen = new Set<string>()
      zip.on('error', reject)
      zip.on('entry', (e: yauzl.Entry) => {
        const name = e.fileName.replace(/\\/g, '/')
        const out = path.resolve(base, name)
        if (out !== base && !out.startsWith(base + path.sep)) {
          zip.close()
          return reject(new Error(`Niedozwolona ścieżka w archiwum: ${e.fileName}`))
        }
        seen.add(name.toLowerCase())
        if (name.endsWith('/')) {
          void fs.mkdir(out, { recursive: true }).then(() => zip.readEntry(), reject)
          return
        }
        zip.openReadStream(e, (e2, stream) => {
          if (e2 || !stream) return reject(e2 ?? new Error('Błąd archiwum.'))
          void fs.mkdir(path.dirname(out), { recursive: true }).then(() => {
            const w = createWriteStream(out)
            stream.pipe(w)
            w.on('finish', () => zip.readEntry())
            w.on('error', reject)
          }, reject)
        })
      })
      zip.on('end', () => {
        if (!seen.has('lumen.exe') || !seen.has('resources/app.asar')) reject(new Error('Archiwum nie wygląda jak Lumen (brak Lumen.exe / resources/app.asar).'))
        else resolve()
      })
      zip.readEntry()
    })
  })
}

const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** PowerShell script that swaps the program after Lumen exits (see the module comment). */
export const UPDATE_TASK = 'Lumen Update'

export function applyScript(o: {
  flavor: Exclude<UpdateFlavor, 'dev'>
  pid: number
  appDir: string
  exe: string
  updateDir: string
  logFile: string
  file: string
  portableFile?: string
  /** LUMEN_* variables of the running Lumen, restored for the restarted one */
  env?: Record<string, string>
}): string {
  const env = Object.entries(o.env ?? {})
    .filter(([k]) => /^LUMEN_[A-Z_]+$/.test(k))
    .map(([k, v]) => `$env:${k} = ${ps(v)}`)
    .join('\n')
  const head = `$ErrorActionPreference = 'Continue'
$app = ${ps(o.appDir)}; $exe = ${ps(o.exe)}; $upd = ${ps(o.updateDir)}; $log = ${ps(o.logFile)}
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
# pełne ścieżki: Lumen bywa uruchomiony z PATH bez System32 (wtedy „robocopy” nie istniał, a pusty kod uznany był za sukces)
$sys = [Environment]::SystemDirectory; $robo = Join-Path $sys 'robocopy.exe'
function L($m) { Add-Content -LiteralPath $log -Encoding UTF8 -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $m) }
L 'aktualizacja Lumen: czekam na zamknięcie (PID ${o.pid})'
Wait-Process -Id ${o.pid} -Timeout 90 -ErrorAction SilentlyContinue
# silnik EmuStart z folderu programu też musi się zamknąć (kończy wysyłanie zapisów)
for ($i = 0; $i -lt 120; $i++) {
  $busy = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($app, [StringComparison]::OrdinalIgnoreCase) }
  if (-not $busy) { break }; Start-Sleep 1
}
`
  const start = `
${env}
Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
L 'Lumen uruchomiony ponownie'
& (Join-Path $env:SystemRoot 'System32\\schtasks.exe') /Delete /TN ${ps(UPDATE_TASK)} /F 2>$null | Out-Null
`
  if (o.flavor === 'zip') {
    return (
      head +
      `$new = Join-Path $upd 'new'; $bak = Join-Path $upd 'backup'
L 'kopia zapasowa programu (bez LumenData)'
& $robo $app $bak /MIR /XD LumenData /R:5 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
L 'podmiana plików'
& $robo $new $app /MIR /XD LumenData /R:30 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
$rc = $LASTEXITCODE
if ($null -eq $rc -or $rc -ge 8) {
  L "BŁĄD podmiany (robocopy $rc) — przywracam poprzednią wersję"
  & $robo $bak $app /MIR /XD LumenData /R:30 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  L "podmiana zakończona (robocopy $rc)"
  Remove-Item -LiteralPath $new -Recurse -Force -ErrorAction SilentlyContinue
}` +
      start
    )
  }
  if (o.flavor === 'installed') {
    return (
      head +
      `L 'instalator (cicho)'
$p = Start-Process -FilePath ${ps(o.file)} -ArgumentList '/S' -Wait -PassThru
L "instalator zakończony (kod $($p.ExitCode))"` +
      start
    )
  }
  return (
    head +
    `$target = ${ps(o.portableFile ?? o.exe)}; $bak = Join-Path $upd ('backup-' + (Split-Path $target -Leaf))
Copy-Item -LiteralPath $target -Destination $bak -Force
$ok = $false
for ($i = 0; $i -lt 60; $i++) { try { Copy-Item -LiteralPath ${ps(o.file)} -Destination $target -Force -ErrorAction Stop; $ok = $true; break } catch { Start-Sleep 1 } }
if ($ok) { L 'podmiana pliku zakończona' } else { L 'BŁĄD podmiany — przywracam poprzedni plik'; Copy-Item -LiteralPath $bak -Destination $target -Force }
$exe = $target` +
    start
  )
}

/**
 * Starts the swap script outside Lumen's process tree. A child process would die with Lumen when the
 * process runs inside a job object (the launcher's, the shell's) — EmuStart breaks away from the job
 * (CREATE_BREAKAWAY_FROM_JOB), which Node cannot. A one-shot Task Scheduler task for the current user
 * runs in the user's session, independent of Lumen (the script deletes it). Fallback: a hidden child
 * process (not DETACHED_PROCESS — PowerShell without a console exits at once, see EmuStart).
 */
// full paths: Lumen can run with a PATH without System32 (then `schtasks` → ENOENT and the fallback
// child process dies with Lumen — the update never happened)
const SYS32 = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32')
const POWERSHELL = path.join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function startScript(script: string, cwd: string): Promise<string> {
  const tr = `"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`
  const run = (args: string[]): Promise<void> =>
    new Promise((resolve, reject) => execFile(path.join(SYS32, 'schtasks.exe'), args, { windowsHide: true, timeout: 15000 }, (e) => (e ? reject(e) : resolve())))
  return run(['/Create', '/F', '/TN', UPDATE_TASK, '/SC', 'ONCE', '/ST', '00:00', '/IT', '/TR', tr])
    .then(() => run(['/Run', '/TN', UPDATE_TASK]))
    .then(() => 'zadanie Harmonogramu')
    .catch((e) => {
      log.warn('update', `scheduled task: ${(e as Error).message} — starting the script directly`)
      spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore', windowsHide: true, cwd }).unref()
      return 'proces'
    })
}

/** recursive delete that also removes app.asar files as plain files (Electron) */
async function rmNoAsar(dir: string): Promise<void> {
  const proc = process as NodeJS.Process & { noAsar?: boolean }
  const before = proc.noAsar
  proc.noAsar = true
  try {
    await fs.rm(dir, { recursive: true, force: true })
  } finally {
    proc.noAsar = before
  }
}

export interface UpdaterOptions {
  current: string
  flavor: UpdateFlavor
  /** LumenData */
  dataDir: string
  exe: string
  portableFile?: string
  /** development/tests only: a local release feed instead of GitHub (LUMEN_UPDATE_FEED) */
  feed?: string
  /** tests only: how long the version check waits for GitHub (default 20 s) */
  checkTimeoutMs?: number
  quit: () => void
}

export class Updater extends EventEmitter {
  private s: UpdateState = { phase: 'idle', done: 0, total: 0 }
  private abort: AbortController | null = null
  private downloaded = ''

  constructor(private readonly o: UpdaterOptions) {
    super()
  }

  get state(): UpdateState {
    return this.s
  }

  private set(p: Partial<UpdateState>): void {
    this.s = { ...this.s, ...p }
    this.emit('state', this.s)
  }

  private get updateDir(): string {
    return path.join(this.o.dataDir, 'update')
  }

  /** download addresses must come from this repository's releases (or the explicit test feed) */
  private allowed(url: string): boolean {
    if (this.o.feed) return url.startsWith(new URL(this.o.feed).origin + '/')
    return url.startsWith(DOWNLOAD_PREFIX)
  }

  async check(): Promise<UpdateState> {
    if (this.o.flavor === 'dev') {
      this.set({ phase: 'none', error: 'Wersja ze źródeł nie aktualizuje się sama (git pull + npm run build).' })
      return this.s
    }
    if (['downloading', 'verifying', 'extracting', 'applying'].includes(this.s.phase)) return this.s
    // a downloaded update stays ready when the same version is still the latest
    const readyVersion = this.s.phase === 'ready' ? this.s.info?.version : undefined
    this.set({ phase: 'checking', error: undefined })
    try {
      // a stalled connection must not leave "checking" on screen for good
      const res = await fetch(this.o.feed ?? API_URL, {
        headers: { 'User-Agent': `Lumen/${this.o.current}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(this.o.checkTimeoutMs ?? 20_000)
      }).catch((e: Error) => {
        throw e.name === 'TimeoutError' ? new Error('GitHub nie odpowiada') : e
      })
      if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`)
      const info = readRelease(await res.json(), this.o.flavor, this.o.current)
      const phase = !info.newer ? 'none' : !info.file ? 'none' : readyVersion === info.version ? 'ready' : 'available'
      this.set({
        phase,
        info,
        checkedAt: Date.now(),
        error: info.newer && !info.file ? `Wydanie ${info.version} nie ma pliku dla tej wersji programu.` : undefined
      })
      log.info('update', `latest ${info.version}, current ${this.o.current}, ${info.newer ? 'newer' : 'up to date'}`)
    } catch (e) {
      this.set({ phase: 'error', error: `Nie udało się sprawdzić aktualizacji: ${(e as Error).message}` })
    }
    return this.s
  }

  async download(): Promise<UpdateState> {
    const info = this.s.info
    if (this.s.phase !== 'available' || !info?.file) return this.s
    const file = info.file
    const dir = this.updateDir
    try {
      if (!this.allowed(file.url) || (info.sigUrl && !this.allowed(info.sigUrl))) throw new Error(`Nieoczekiwany adres aktualizacji: ${file.url}`)
      if (!info.sigUrl) throw new Error('Wydanie nie ma podpisu Lumen (.sig) — aktualizacja wstrzymana.')
      await rmNoAsar(dir)
      await fs.mkdir(dir, { recursive: true })
      const dest = path.join(dir, file.name)
      const part = dest + '.part'
      this.abort = new AbortController()
      this.set({ phase: 'downloading', done: 0, total: file.size, error: undefined })
      const res = await fetch(file.url, { headers: { 'User-Agent': `Lumen/${this.o.current}` }, signal: this.abort.signal, redirect: 'follow' })
      if (!res.ok || !res.body) throw new Error(`Pobieranie: HTTP ${res.status}`)
      const h = createHash('sha256')
      const out = createWriteStream(part)
      let done = 0
      let last = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        h.update(chunk)
        done += chunk.length
        if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
        if (Date.now() - last > 250) {
          last = Date.now()
          this.set({ done })
        }
      }
      await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
      this.set({ phase: 'verifying', done })
      if (file.size && done !== file.size) throw new Error(`Pobrano ${done} z ${file.size} B — spróbuj ponownie.`)
      const sha = h.digest('hex')
      if (file.sha256 && sha !== file.sha256) throw new Error('Pobrany plik ma inny skrót SHA-256 niż plik wydania — aktualizacja przerwana.')
      const sigRes = await fetch(info.sigUrl, { headers: { 'User-Agent': `Lumen/${this.o.current}` } })
      const sig = sigRes.ok ? await sigRes.text() : ''
      if (!verifyRelease(file.name, sha, sig)) throw new Error('Wydanie nie ma poprawnego podpisu Lumen — aktualizacja wstrzymana (plik mógł zostać podmieniony).')
      await fs.rename(part, dest)
      if (this.o.flavor === 'zip') {
        this.set({ phase: 'extracting' })
        await extractZip(dest, path.join(dir, 'new'))
        await fs.rm(dest, { force: true })
      }
      this.downloaded = dest
      this.set({ phase: 'ready' })
      log.info('update', `${info.version} ready (${this.o.flavor}, sha256 ${sha.slice(0, 16)}…, signature ok)`)
    } catch (e) {
      const aborted = this.abort?.signal.aborted
      log.warn('update', `download: ${(e as Error).message}`)
      await rmNoAsar(dir).catch(() => undefined)
      this.set({ phase: aborted ? 'available' : 'error', error: aborted ? undefined : (e as Error).message, done: 0 })
    } finally {
      this.abort = null
    }
    return this.s
  }

  cancel(): void {
    this.abort?.abort()
  }

  /** Start the swap script and close Lumen (the script restarts it). */
  async apply(): Promise<UpdateState> {
    if (this.s.phase !== 'ready' || this.o.flavor === 'dev') return this.s
    const logFile = path.join(this.o.dataDir, 'logs', 'update.log')
    const script = path.join(this.updateDir, 'apply.ps1')
    const appDir = path.dirname(this.o.exe)
    await fs.writeFile(
      script,
      '﻿' +
        applyScript({
          flavor: this.o.flavor,
          pid: process.pid,
          appDir,
          exe: this.o.exe,
          updateDir: this.updateDir,
          logFile,
          file: this.downloaded,
          portableFile: this.o.portableFile,
          env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[0].startsWith('LUMEN_') && !!e[1]))
        }),
      'utf8'
    )
    const before = await fs.stat(logFile).then((s) => s.size, () => 0)
    const how = await startScript(script, this.updateDir)
    log.info('update', `swap script started (${how})`)
    // close only once the script has started (it writes its PID line) — otherwise keep running
    const mark = `PID ${process.pid}`
    for (let i = 0; i < 60; i++) {
      const text = await fs.readFile(logFile).then((b) => b.subarray(before).toString('utf8'), () => '')
      if (text.includes(mark)) {
        this.set({ phase: 'applying' })
        log.info('update', `applying ${this.s.info?.version}: swap after exit`)
        setTimeout(() => this.o.quit(), 300)
        return this.s
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    this.set({ phase: 'error', error: 'Skrypt podmiany nie wystartował — Lumen działa dalej na obecnej wersji (szczegóły w logach).' })
    return this.s
  }
}
