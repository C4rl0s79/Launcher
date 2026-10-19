import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

const { LibraryService } = await import('../src/main/library/service')

describe('running game tracking', () => {
  it('emits start/exit exactly once per transition, whoever observes it first', () => {
    const svc = new LibraryService({ get: () => ({}), getSecret: () => undefined } as never, 'unused.json')
    const events: string[] = []
    svc.on('gameStarted', (id: number) => events.push(`start:${id}`))
    svc.on('gameExited', (id: number) => events.push(`exit:${id}`))
    const track = (v: number | undefined): void => (svc as unknown as { trackRunning(v?: number): void }).trackRunning(v)

    track(370360) // seen by a full scan (manifest rewrite)
    track(370360) // then by the poll — no duplicate
    track(undefined) // game closed
    track(undefined)
    track(620)
    track(440) // switched directly to another game
    expect(events).toEqual(['start:370360', 'exit:370360', 'start:620', 'exit:620', 'start:440'])
  })
})
