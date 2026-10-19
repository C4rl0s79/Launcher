import { execFile } from 'node:child_process'

// Read-only access to the Windows registry through reg.exe (no native modules needed).
// Steam writes a few runtime values under HKCU\Software\Valve\Steam; these are not a
// documented API, so every caller must tolerate missing values.

export type RegValues = Record<string, string | number>

export function parseRegQuery(output: string): RegValues {
  const values: RegValues = {}
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s{2,}(.+?)\s{2,}(REG_\w+)(?:\s+(.*))?$/.exec(line)
    if (!m) continue
    const [, name, type, raw] = m
    const data = (raw ?? '').trim()
    if (type === 'REG_DWORD' || type === 'REG_QWORD') {
      values[name] = Number.parseInt(data, 16)
    } else {
      values[name] = data
    }
  }
  return values
}

export function queryRegistry(key: string, timeoutMs = 3000): Promise<RegValues | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null)
      resolve(parseRegQuery(stdout))
    })
  })
}

export interface SteamRegistryState {
  steamPath?: string
  steamExe?: string
  activePid?: number
  activeUserAccountId?: number
  runningAppId?: number
}

export async function readSteamRegistry(): Promise<SteamRegistryState> {
  const [hkcu, active, hklm] = await Promise.all([
    queryRegistry('HKCU\\Software\\Valve\\Steam'),
    queryRegistry('HKCU\\Software\\Valve\\Steam\\ActiveProcess'),
    queryRegistry('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam')
  ])
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)
  return {
    steamPath: str(hkcu?.SteamPath) ?? str(hklm?.InstallPath),
    steamExe: str(hkcu?.SteamExe),
    activePid: num(active?.pid),
    activeUserAccountId: num(active?.ActiveUser),
    runningAppId: num(hkcu?.RunningAppID)
  }
}

/** Steam is considered running when its ActiveProcess pid is alive. */
export function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the process exists but belongs to someone else
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
