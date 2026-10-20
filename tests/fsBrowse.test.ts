import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { listDir, matchesExtension, parentOf } from '../src/main/fsBrowse'

function tree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'lumen-fs-'))
  for (const d of ['zeta', 'Alpha', 'gry 10', 'gry 2', '$RECYCLE.BIN', 'System Volume Information']) mkdirSync(path.join(root, d))
  for (const f of ['cover.PNG', 'notes.txt', 'python.exe', 'desktop.ini']) writeFileSync(path.join(root, f), 'x')
  return root
}

describe('path picker listing', () => {
  it('folder mode: only folders, sorted naturally, system folders hidden', async () => {
    const root = tree()
    const l = await listDir(root, { kind: 'folder' })
    expect(l.entries.map((e) => e.name)).toEqual(['Alpha', 'gry 2', 'gry 10', 'zeta'])
    expect(l.entries.every((e) => e.kind === 'dir')).toBe(true)
    expect(l.parent).toBe(path.dirname(root))
  })

  it('file mode: folders first, then files with an allowed extension (any case)', async () => {
    const root = tree()
    const l = await listDir(root, { kind: 'file', extensions: ['png', 'jpg'] })
    expect(l.entries.filter((e) => e.kind === 'file').map((e) => e.name)).toEqual(['cover.PNG'])
    expect(l.entries[0].kind).toBe('dir')
    const exe = await listDir(root, { kind: 'file', extensions: ['exe'] })
    expect(exe.entries.filter((e) => e.kind === 'file').map((e) => e.name)).toEqual(['python.exe'])
  })

  it('first page: shortcuts before drives; missing folder is an error, not a crash', async () => {
    const first = await listDir('', { kind: 'folder' }, [{ name: 'Folder danych Lumen', path: 'D:\\x', kind: 'place' }])
    expect(first.parent).toBeNull()
    expect(first.entries[0]).toMatchObject({ kind: 'place' })
    const missing = await listDir(path.join(tree(), 'nie-ma'), { kind: 'folder' })
    expect(missing.error).toMatch(/nie istnieje/)
    expect(missing.entries).toEqual([])
  })

  it('goes up to the drive root and then to the first page', () => {
    expect(parentOf('D:\\Games\\Lumen')).toBe('D:\\Games')
    expect(parentOf('D:\\Games')).toBe('D:\\')
    expect(parentOf('D:\\')).toBe('')
    expect(matchesExtension('a.JPEG', ['jpeg'])).toBe(true)
    expect(matchesExtension('a.txt', ['png'])).toBe(false)
  })
})
