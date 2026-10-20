import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import type { FsEntry, FsListing, FsListOptions } from '@shared/types'

// Read-only listing for the in-app path picker (operable with a gamepad — the Windows file
// dialog is not). Only names and types are returned; nothing is opened or changed.

const MAX_ENTRIES = 3000
const HIDDEN = /^(\$|System Volume Information$|Recovery$|Config\.Msi$|desktop\.ini$|thumbs\.db$)/i

let drivesCache: { at: number; drives: FsEntry[] } | null = null

/** Drive letters with labels ("D: DATA", network drives marked). */
export async function listDrives(): Promise<FsEntry[]> {
  if (drivesCache && Date.now() - drivesCache.at < 30_000) return drivesCache.drives
  const labels = await driveLabels()
  const drives: FsEntry[] = []
  for (let c = 67; c <= 90; c++) {
    const letter = String.fromCharCode(c)
    const root = `${letter}:\\`
    if (!labels.has(letter) && !existsSync(root)) continue
    const info = labels.get(letter)
    drives.push({ name: info?.label ? `${letter}: ${info.label}` : `${letter}:`, path: root, kind: 'drive', note: info?.network ? 'sieć' : 'dysk' })
  }
  drivesCache = { at: Date.now(), drives }
  return drives
}

function driveLabels(): Promise<Map<string, { label: string; network: boolean }>> {
  if (process.platform !== 'win32') return Promise.resolve(new Map())
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | ForEach-Object { "$($_.DeviceID)|$($_.VolumeName)|$($_.DriveType)" }'],
      { windowsHide: true, timeout: 8000 },
      (err, out) => {
        const m = new Map<string, { label: string; network: boolean }>()
        if (!err)
          for (const line of out.split(/\r?\n/)) {
            const [id, label, type] = line.trim().split('|')
            if (/^[A-Z]:$/i.test(id ?? '')) m.set(id[0].toUpperCase(), { label: label ?? '', network: type === '4' })
          }
        resolve(m)
      }
    )
  })
}

export function matchesExtension(name: string, extensions?: string[]): boolean {
  if (!extensions?.length) return true
  const ext = path.extname(name).slice(1).toLowerCase()
  return extensions.some((e) => e.toLowerCase() === ext)
}

/** Parent folder; '' = the list of drives. */
export function parentOf(dir: string): string {
  const p = path.win32.parse(dir)
  if (!dir || path.win32.resolve(dir) === p.root) return ''
  return path.win32.dirname(path.win32.resolve(dir))
}

/** Folders (and files, when picking a file) in `dir`; '' lists drives and shortcuts. */
export async function listDir(dir: string, opts: FsListOptions, places: FsEntry[] = []): Promise<FsListing> {
  if (!dir) return { path: '', parent: null, entries: [...places, ...(await listDrives())], truncated: false }
  const abs = path.win32.resolve(dir)
  let items: import('node:fs').Dirent[]
  try {
    items = await fs.readdir(abs, { withFileTypes: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return {
      path: abs,
      parent: parentOf(abs),
      entries: [],
      truncated: false,
      error: code === 'EPERM' || code === 'EACCES' ? 'Brak dostępu do tego folderu.' : code === 'ENOENT' ? 'Ten folder nie istnieje.' : 'Nie można odczytać folderu.'
    }
  }
  const dirs: FsEntry[] = []
  const files: FsEntry[] = []
  for (const d of items) {
    if (HIDDEN.test(d.name)) continue
    const full = path.win32.join(abs, d.name)
    if (d.isDirectory()) dirs.push({ name: d.name, path: full, kind: 'dir' })
    else if (opts.kind === 'file' && d.isFile() && matchesExtension(d.name, opts.extensions)) files.push({ name: d.name, path: full, kind: 'file' })
  }
  const byName = (a: FsEntry, b: FsEntry): number => a.name.localeCompare(b.name, 'pl', { sensitivity: 'base', numeric: true })
  const all = [...dirs.sort(byName), ...files.sort(byName)]
  return { path: abs, parent: parentOf(abs), entries: all.slice(0, MAX_ENTRIES), truncated: all.length > MAX_ENTRIES }
}
