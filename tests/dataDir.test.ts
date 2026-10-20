import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { chooseDataDir, migrateDataDir } from '../src/main/dataDir'

const base = { exeDir: 'D:\\Games\\Lumen', packaged: true, defaultDir: 'C:\\Users\\x\\AppData\\Roaming\\Lumen' }

describe('data folder next to the exe', () => {
  it('installed and folder (zip) builds use LumenData next to Lumen.exe', () => {
    expect(chooseDataDir(base, () => true)).toEqual({ dir: path.join('D:\\Games\\Lumen', 'LumenData') })
  })
  it('portable exe uses the folder of the .exe, not the unpacked copy', () => {
    expect(chooseDataDir({ ...base, portableDir: 'E:\\USB' }, () => true).dir).toBe(path.join('E:\\USB', 'LumenData'))
  })
  it('a read-only program folder falls back to AppData and says why', () => {
    const c = chooseDataDir(base, () => false)
    expect(c.dir).toBe(base.defaultDir)
    expect(c.warning).toMatch(/tylko do odczytu/)
  })
  it('development and LUMEN_USER_DATA keep their folders', () => {
    expect(chooseDataDir({ ...base, packaged: false }, () => true).dir).toBe(base.defaultDir)
    expect(chooseDataDir({ ...base, override: 'D:\\t' }, () => true).dir).toBe(path.resolve('D:\\t'))
  })
})

describe('migration from the old data folder', () => {
  const setup = (): { from: string; to: string } => {
    const root = mkdtempSync(path.join(tmpdir(), 'lumen-mig-'))
    const from = path.join(root, 'old')
    const to = path.join(root, 'new')
    mkdirSync(path.join(from, 'custom-art'), { recursive: true })
    mkdirSync(path.join(from, 'cache', 'art'), { recursive: true })
    writeFileSync(path.join(from, 'settings.json'), '{"version":1}')
    const art = path.join(from, 'custom-art', 'steam_10-grid-1.png')
    writeFileSync(art, 'png')
    writeFileSync(path.join(from, 'prefs.json'), JSON.stringify({ art: { 'steam:10': { grid: { type: 'file', file: art } } } }))
    writeFileSync(path.join(from, 'cache', 'art', 'big.webp'), 'x')
    return { from, to }
  }

  it('copies Lumen data, rewrites custom art paths and leaves the old folder intact', () => {
    const { from, to } = setup()
    const copied = migrateDataDir(from, to)
    expect(copied).toEqual(expect.arrayContaining(['settings.json', 'prefs.json', 'custom-art']))
    const prefs = JSON.parse(readFileSync(path.join(to, 'prefs.json'), 'utf8'))
    expect(prefs.art['steam:10'].grid.file).toBe(path.join(to, 'custom-art', 'steam_10-grid-1.png'))
    expect(existsSync(prefs.art['steam:10'].grid.file)).toBe(true)
    expect(existsSync(path.join(to, 'cache', 'art', 'big.webp'))).toBe(false) // caches are rebuilt, not copied
    expect(readFileSync(path.join(from, 'prefs.json'), 'utf8')).toContain(path.join(from, 'custom-art').replace(/\\/g, '\\\\'))
  })

  it('never overwrites a data folder that is already in use', () => {
    const { from, to } = setup()
    mkdirSync(to, { recursive: true })
    writeFileSync(path.join(to, 'settings.json'), '{"mine":true}')
    expect(migrateDataDir(from, to)).toEqual([])
    expect(readFileSync(path.join(to, 'settings.json'), 'utf8')).toBe('{"mine":true}')
  })
})
