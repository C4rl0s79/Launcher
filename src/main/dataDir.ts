import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Where Lumen keeps its data. Packaged builds (installer and portable) keep everything in
// `LumenData\` next to the exe: settings, caches, the EmuStart engine data with the game cache,
// emulators and BIOS files, temporary files. Nothing outside the app folder (Steam is only read).

export const DATA_DIR_NAME = 'LumenData'

export interface DataDirInput {
  /** LUMEN_USER_DATA (tests, development) */
  override?: string
  /** PORTABLE_EXECUTABLE_DIR (portable exe: the folder of the .exe, not the unpacked temp copy) */
  portableDir?: string
  /** folder of the running exe (installed build) */
  exeDir: string
  packaged: boolean
  /** Electron's default userData (%APPDATA%\Lumen) — used in development and as a fallback */
  defaultDir: string
}

export interface DataDirChoice {
  dir: string
  /** why the default location was not used (shown in the log and in Settings) */
  warning?: string
}

export function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    const probe = path.join(dir, `.write-test-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

export function chooseDataDir(i: DataDirInput, writable: (dir: string) => boolean = isWritable): DataDirChoice {
  if (i.override) return { dir: path.resolve(i.override) }
  if (i.portableDir) return { dir: path.join(i.portableDir, DATA_DIR_NAME) }
  if (!i.packaged) return { dir: i.defaultDir }
  const next = path.join(i.exeDir, DATA_DIR_NAME)
  if (writable(next)) return { dir: next }
  return {
    dir: i.defaultDir,
    warning: `Folder programu (${i.exeDir}) jest tylko do odczytu — dane są w ${i.defaultDir}. Zainstaluj Lumen w folderze z prawem zapisu, aby trzymać dane obok programu.`
  }
}

/** Lumen's own files (not Chromium's caches) worth carrying over from an older data folder. */
export const MIGRATED_ENTRIES = [
  'prefs.json',
  'prefs.json.bak',
  'settings.json',
  'settings.json.bak',
  'secrets.json',
  'first-seen.json',
  'emustart-library.json',
  'custom-art',
  'launchbox',
  path.join('cache', 'account-library.json')
]

/**
 * First start with a new data folder: copy the user's data from the old one (%APPDATA%\Lumen).
 * The old folder is left untouched (rollback = run an older Lumen). Custom art paths in prefs.json
 * are rewritten to the new folder. Returns the copied entries.
 */
export function migrateDataDir(from: string, to: string): string[] {
  if (path.resolve(from) === path.resolve(to)) return []
  if (!existsSync(from) || existsSync(path.join(to, 'settings.json')) || existsSync(path.join(to, 'prefs.json'))) return []
  const copied: string[] = []
  for (const rel of MIGRATED_ENTRIES) {
    const src = path.join(from, rel)
    if (!existsSync(src)) continue
    const dst = path.join(to, rel)
    mkdirSync(path.dirname(dst), { recursive: true })
    cpSync(src, dst, { recursive: true, errorOnExist: false, force: false })
    copied.push(rel)
  }
  for (const name of ['prefs.json', 'prefs.json.bak']) {
    const p = path.join(to, name)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    const oldArt = JSON.stringify(path.join(from, 'custom-art')).slice(1, -1)
    const newArt = JSON.stringify(path.join(to, 'custom-art')).slice(1, -1)
    if (text.includes(oldArt)) writeFileSync(p, text.split(oldArt).join(newArt))
  }
  return copied
}
