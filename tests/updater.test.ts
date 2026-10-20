import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { crc32 } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { applyScript, detectFlavor, extractZip, isNewer, readRelease, Updater } from '../src/main/updater'
import { releaseMessage, verifyRelease } from '../src/main/releaseSigning'

/** Minimal ZIP (stored entries) for the tests. */
function makeZip(file: string, entries: Record<string, string>): void {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text)
    const n = Buffer.from(name)
    const crc = crc32(data)
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(data.length, 18)
    h.writeUInt32LE(data.length, 22)
    h.writeUInt16LE(n.length, 26)
    local.push(h, n, data)
    const c = Buffer.alloc(46)
    c.writeUInt32LE(0x02014b50, 0)
    c.writeUInt16LE(20, 4)
    c.writeUInt16LE(20, 6)
    c.writeUInt32LE(crc, 16)
    c.writeUInt32LE(data.length, 20)
    c.writeUInt32LE(data.length, 24)
    c.writeUInt16LE(n.length, 28)
    c.writeUInt32LE(offset, 42)
    central.push(c, n)
    offset += 30 + n.length + data.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  writeFileSync(file, Buffer.concat([...local, cd, end]))
}

const release = {
  tag_name: 'v0.5.0',
  body: 'Zmiany',
  html_url: 'https://github.com/C4rl0s79/Launcher/releases/tag/v0.5.0',
  assets: [
    { name: 'Lumen-0.5.0-win64.zip', size: 10, browser_download_url: 'https://github.com/C4rl0s79/Launcher/releases/download/v0.5.0/Lumen-0.5.0-win64.zip', digest: 'sha256:AB' },
    { name: 'Lumen-0.5.0-win64.zip.sig', size: 1, browser_download_url: 'https://github.com/C4rl0s79/Launcher/releases/download/v0.5.0/Lumen-0.5.0-win64.zip.sig' },
    { name: 'Lumen-0.5.0-setup.exe', size: 20, browser_download_url: 'https://github.com/C4rl0s79/Launcher/releases/download/v0.5.0/Lumen-0.5.0-setup.exe' },
    { name: 'Lumen-0.5.0-portable.exe', size: 30, browser_download_url: 'https://github.com/C4rl0s79/Launcher/releases/download/v0.5.0/Lumen-0.5.0-portable.exe' }
  ]
}

describe('updater', () => {
  it('compares versions', () => {
    expect(isNewer('0.5.0', '0.4.9')).toBe(true)
    expect(isNewer('0.4.10', '0.4.9')).toBe(true)
    expect(isNewer('0.4.0', '0.4.0')).toBe(false)
    expect(isNewer('0.3.9', '0.4.0')).toBe(false)
  })

  it('knows the build: folder (zip), installed, portable, sources', () => {
    expect(detectFlavor({ packaged: false, exeDir: 'X' })).toBe('dev')
    expect(detectFlavor({ packaged: true, exeDir: 'X', portableFile: 'E:\\Lumen.exe' })).toBe('portable')
    expect(detectFlavor({ packaged: true, exeDir: 'X', exists: (p) => p.endsWith('Uninstall Lumen.exe') })).toBe('installed')
    expect(detectFlavor({ packaged: true, exeDir: 'X', exists: () => false })).toBe('zip')
  })

  it('picks the file of its own build, with checksum and signature', () => {
    const z = readRelease(release, 'zip', '0.4.0')
    expect(z).toMatchObject({ version: '0.5.0', newer: true, file: { name: 'Lumen-0.5.0-win64.zip', size: 10, sha256: 'ab' } })
    expect(z.sigUrl).toMatch(/win64\.zip\.sig$/)
    expect(readRelease(release, 'installed', '0.4.0').file?.name).toBe('Lumen-0.5.0-setup.exe')
    expect(readRelease(release, 'installed', '0.4.0').sigUrl).toBeUndefined()
    expect(readRelease(release, 'portable', '0.6.0').newer).toBe(false)
  })

  it('accepts only a signature made with the release key for that very file', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    const sha = createHash('sha256').update('data').digest('hex')
    const sig = sign(null, releaseMessage('Lumen-0.5.0-win64.zip', sha), privateKey).toString('base64')
    expect(verifyRelease('Lumen-0.5.0-win64.zip', sha, sig, pub)).toBe(true)
    expect(verifyRelease('Lumen-0.4.0-win64.zip', sha, sig, pub)).toBe(false) // older file passed off as new
    expect(verifyRelease('Lumen-0.5.0-win64.zip', '00' + sha.slice(2), sig, pub)).toBe(false)
    expect(verifyRelease('Lumen-0.5.0-win64.zip', sha, sig)).toBe(false) // not the Lumen release key
    expect(verifyRelease('x', sha, 'garbage', pub)).toBe(false)
  })

  it('unpacks the folder version, refusing paths outside it and archives that are not Lumen', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lumen-upd-'))
    const good = path.join(dir, 'good.zip')
    makeZip(good, { 'Lumen.exe': 'exe', 'resources/app.asar': 'asar', 'locales/pl.pak': 'pak' })
    await extractZip(good, path.join(dir, 'new'))
    expect(readFileSync(path.join(dir, 'new', 'resources', 'app.asar'), 'utf8')).toBe('asar')
    const evil = path.join(dir, 'evil.zip')
    makeZip(evil, { 'Lumen.exe': 'exe', '../outside.txt': 'x' })
    await expect(extractZip(evil, path.join(dir, 'new2'))).rejects.toThrow(/Niedozwolona|invalid relative path/)
    expect(existsSync(path.join(dir, 'outside.txt'))).toBe(false)
    const other = path.join(dir, 'other.zip')
    makeZip(other, { 'readme.txt': 'x' })
    await expect(extractZip(other, path.join(dir, 'new3'))).rejects.toThrow(/nie wygląda jak Lumen/)
  })

  it('swap script never touches LumenData and restores the backup on failure', () => {
    const base = { pid: 42, appDir: 'D:\\Lumen', exe: 'D:\\Lumen\\Lumen.exe', updateDir: 'D:\\Lumen\\LumenData\\update', logFile: 'D:\\Lumen\\LumenData\\logs\\update.log', file: 'x' }
    const zip = applyScript({ ...base, flavor: 'zip' })
    expect(zip).toContain('Wait-Process -Id 42')
    expect(zip.match(/robocopy [^\n]*\/MIR \/XD LumenData/g)).toHaveLength(3) // backup, swap, restore
    expect(zip).toContain('przywracam poprzednią wersję')
    expect(zip).toContain("schtasks /Delete /TN 'Lumen Update'")
    const withEnv = applyScript({ ...base, flavor: 'zip', env: { LUMEN_USER_DATA: "D:\\it's", PATH: 'x' } })
    expect(withEnv).toContain("$env:LUMEN_USER_DATA = 'D:\\it''s'")
    expect(withEnv).not.toContain('$env:PATH')
    expect(applyScript({ ...base, flavor: 'installed', file: 'D:\\Lumen\\LumenData\\update\\Lumen-0.5.0-setup.exe' })).toContain("-ArgumentList '/S' -Wait")
    const portable = applyScript({ ...base, flavor: 'portable', file: 'new.exe', portableFile: "E:\\Gry\\Lumen-0.4.0-portable.exe" })
    expect(portable).toContain("$target = 'E:\\Gry\\Lumen-0.4.0-portable.exe'")
    expect(portable).toContain('przywracam poprzedni plik')
  })

  it('a downloaded update stays ready when checked again (daily check after download)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(release)))
    const u = new Updater({ current: '0.4.0', flavor: 'zip', dataDir: tmpdir(), exe: 'X:\Lumen.exe', quit: () => undefined })
    expect((await u.check()).phase).toBe('available')
    ;(u as unknown as { s: { phase: string } }).s.phase = 'ready'
    expect((await u.check()).phase).toBe('ready')
    fetchMock.mockRestore()
  })
})
