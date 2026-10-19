import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defaultPrefs, migratePrefs, ops, PrefsError, PrefsStore } from '../src/main/store/prefs'
import { JsonFile } from '../src/main/store/jsonFile'
import { redact, registerSecret } from '../src/main/logger'

const tmp = (): string => mkdtempSync(path.join(tmpdir(), 'lumen-prefs-'))

describe('category operations', () => {
  it('creates, renames, pins, reorders and deletes custom categories', () => {
    let p = defaultPrefs()
    p = ops.createCategory(p, '  RPG  ', 'cat:rpg')
    expect(p.categories.find((c) => c.id === 'cat:rpg')).toMatchObject({ name: 'RPG', kind: 'custom', pinned: false })
    p = ops.renameCategory(p, 'cat:rpg', 'Role-playing')
    p = ops.setPinned(p, 'cat:rpg', true)
    const before = [...p.categories].sort((a, b) => a.order - b.order).map((c) => c.id)
    p = ops.moveCategory(p, 'cat:rpg', -10)
    const after = [...p.categories].sort((a, b) => a.order - b.order).map((c) => c.id)
    expect(after[0]).toBe('cat:rpg')
    expect(after.slice(1)).toEqual(before.filter((x) => x !== 'cat:rpg'))
    p = ops.setGameCategories(p, 'steam:1', ['cat:rpg'])
    p = ops.deleteCategory(p, 'cat:rpg')
    expect(p.categories.some((c) => c.id === 'cat:rpg')).toBe(false)
    expect(p.gameCategories['steam:1']).toBeUndefined()
    expect(p.categories.map((c) => c.order)).toEqual(p.categories.map((_, i) => i))
  })

  it('rejects empty and duplicate names (case-insensitive, Polish locale)', () => {
    const p = ops.createCategory(defaultPrefs(), 'Łatwe', 'cat:a')
    expect(() => ops.createCategory(p, '   ')).toThrow(PrefsError)
    expect(() => ops.createCategory(p, 'łatwe')).toThrow(/już istnieje/)
    expect(() => ops.renameCategory(p, 'smart:recent', 'ŁATWE')).toThrow(/już istnieje/)
  })

  it('refuses to delete built-in categories', () => {
    expect(() => ops.deleteCategory(defaultPrefs(), 'smart:installed')).toThrow(PrefsError)
  })

  it('assigns a game to many custom categories, ignoring unknown and smart ids', () => {
    let p = ops.createCategory(defaultPrefs(), 'A', 'cat:a')
    p = ops.createCategory(p, 'B', 'cat:b')
    p = ops.setGameCategories(p, 'steam:620', ['cat:a', 'cat:b', 'cat:a', 'cat:zzz', 'smart:recent'])
    expect(p.gameCategories['steam:620']).toEqual(['cat:a', 'cat:b'])
    p = ops.setGameCategories(p, 'steam:620', [])
    expect(p.gameCategories['steam:620']).toBeUndefined()
  })

  it('toggles favourites', () => {
    let p = ops.toggleFavorite(defaultPrefs(), 'steam:1')
    expect(p.favorites).toEqual(['steam:1'])
    p = ops.toggleFavorite(p, 'steam:1')
    expect(p.favorites).toEqual([])
  })

  it('drops SteamGridDB picks when the match changes but keeps local files', () => {
    let p = ops.setArt(defaultPrefs(), 'steam:1', 'grid', { type: 'sgdb', imageId: 1, url: 'https://cdn2.steamgriddb.com/x.png' })
    p = ops.setArt(p, 'steam:1', 'hero', { type: 'file', file: 'C:\\x.png' })
    p = ops.setSgdbMatch(p, 'steam:1', 42, 'Other')
    expect(p.art['steam:1']).toEqual({ sgdbGameId: 42, sgdbGameName: 'Other', hero: { type: 'file', file: 'C:\\x.png' } })
  })
})

describe('migration', () => {
  it('fills missing smart categories and discards garbage', () => {
    const p = migratePrefs({
      categories: [{ id: 'cat:x', name: 'X', kind: 'custom', pinned: true, order: 0 }, { bogus: true }],
      gameCategories: { 'steam:1': ['cat:x', 5] },
      favorites: ['steam:1', 7]
    })
    expect(p.categories[0].id).toBe('cat:x')
    expect(p.categories.filter((c) => c.kind === 'smart')).toHaveLength(5)
    expect(p.gameCategories).toEqual({ 'steam:1': ['cat:x'] })
    expect(p.favorites).toEqual(['steam:1'])
  })

  it('returns defaults for non-objects', () => {
    expect(migratePrefs('nope')).toEqual(defaultPrefs())
  })
})

describe('persistence', () => {
  it('keeps categories and pins across a "restart"', async () => {
    const file = path.join(tmp(), 'prefs.json')
    const a = new PrefsStore(file)
    await a.init()
    await a.update((p) => ops.createCategory(p, 'Kanapa', 'cat:k'))
    await a.update((p) => ops.setPinned(p, 'cat:k', true))
    await a.update((p) => ops.toggleFavorite(p, 'steam:620'))
    const b = new PrefsStore(file)
    const loaded = await b.init()
    expect(loaded.categories.find((c) => c.id === 'cat:k')?.pinned).toBe(true)
    expect(loaded.favorites).toEqual(['steam:620'])
  })

  it('recovers from a corrupt file using the backup', async () => {
    const file = path.join(tmp(), 'data.json')
    const store = new JsonFile(file, () => ({ v: 0 }))
    await store.save({ v: 1 })
    await store.save({ v: 2 }) // .bak now holds v:1
    writeFileSync(file, '{ broken')
    expect(await store.load()).toEqual({ v: 1 })
  })

  it('falls back to defaults when nothing exists', async () => {
    const store = new JsonFile(path.join(tmp(), 'none.json'), () => ({ v: 'default' }))
    expect(await store.load()).toEqual({ v: 'default' })
  })

  it('serialises concurrent writes and leaves no temp files', async () => {
    const dir = tmp()
    const file = path.join(dir, 'c.json')
    const store = new JsonFile<{ n: number }>(file, () => ({ n: 0 }))
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.save({ n: i })))
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ n: 19 })
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false)
  })
})

describe('log redaction', () => {
  it('masks registered secrets and key parameters', () => {
    registerSecret('ABCDEF0123456789SECRET')
    expect(redact('key ABCDEF0123456789SECRET used')).toBe('key *** used')
    expect(redact('https://api.steampowered.com/x?key=123abc&steamid=1')).toBe('https://api.steampowered.com/x?key=***&steamid=1')
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer ***')
  })
})
