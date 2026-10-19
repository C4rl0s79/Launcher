import { DatabaseSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import sax from 'sax'
import yauzl from 'yauzl'
import { normTitle } from './match'

// Builds the local LaunchBox database from Metadata.zip (LaunchBox Games DB dump).
// Same schema as EmuStart's launchbox.db (games / names / meta), minus images and MAME
// sets which Lumen does not use. Runs inside a worker thread (see worker.ts).

export interface LbGameRow {
  id: number
  name: string
  platform: string
  year: string
  overview: string
  developer: string
  publisher: string
  genres: string
  players: string
  rating: string
}

/**
 * Streams Metadata.xml and reports <Game> and <GameAlternateName> records.
 * Only the fields we use are collected; everything else is skipped without buffering.
 */
export function parseMetadataXml(
  input: Readable,
  onGame: (g: LbGameRow) => void,
  onAltName: (gameId: number, name: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: false })
    let record: 'Game' | 'GameAlternateName' | null = null
    let field: string | null = null
    let text = ''
    let cur: Record<string, string> = {}

    parser.on('opentag', (node) => {
      if (!record && (node.name === 'Game' || node.name === 'GameAlternateName')) {
        record = node.name
        cur = {}
      } else if (record) {
        field = node.name
        text = ''
      }
    })
    parser.on('text', (t) => {
      if (field) text += t
    })
    parser.on('cdata', (t) => {
      if (field) text += t
    })
    parser.on('closetag', (name) => {
      if (record && name === field) {
        cur[name] = text
        field = null
      } else if (name === record) {
        if (record === 'Game') {
          const id = Number(cur.DatabaseID)
          if (id && cur.Name) {
            onGame({
              id,
              name: cur.Name.trim(),
              platform: (cur.Platform ?? '').trim(),
              year: (cur.ReleaseYear || cur.ReleaseDate || '').slice(0, 4),
              overview: (cur.Overview ?? '').trim(),
              developer: (cur.Developer ?? '').trim(),
              publisher: (cur.Publisher ?? '').trim(),
              genres: (cur.Genres ?? '').trim(),
              players: (cur.MaxPlayers ?? '').trim(),
              rating: (cur.CommunityRating ?? '').trim()
            })
          }
        } else {
          const id = Number(cur.DatabaseID)
          if (id && cur.AlternateName) onAltName(id, cur.AlternateName.trim())
        }
        record = null
      }
    })
    parser.on('error', reject)
    parser.on('end', () => resolve())
    input.on('error', reject)
    input.pipe(parser)
  })
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS games(id INTEGER PRIMARY KEY, name TEXT, platform TEXT,
    year TEXT, overview TEXT, developer TEXT, publisher TEXT, genres TEXT,
    players TEXT, rating TEXT);
CREATE TABLE IF NOT EXISTS names(norm TEXT, gid INTEGER, platform TEXT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`

/** Writes parsed records into a fresh SQLite file. Returns counts. */
export async function buildDatabase(
  xml: Readable,
  outPath: string,
  progress: (games: number) => void = () => undefined
): Promise<{ games: number; alts: number }> {
  const db = new DatabaseSync(outPath)
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;')
    db.exec(SCHEMA)
    const insGame = db.prepare('INSERT OR REPLACE INTO games VALUES(?,?,?,?,?,?,?,?,?,?)')
    const insName = db.prepare('INSERT INTO names VALUES(?,?,?)')
    const platformOf = new Map<number, string>()
    let games = 0
    let alts = 0
    db.exec('BEGIN')
    await parseMetadataXml(
      xml,
      (g) => {
        insGame.run(g.id, g.name, g.platform, g.year, g.overview, g.developer, g.publisher, g.genres, g.players, g.rating)
        insName.run(normTitle(g.name), g.id, g.platform)
        platformOf.set(g.id, g.platform)
        if (++games % 5000 === 0) progress(games)
      },
      (gid, name) => {
        insName.run(normTitle(name), gid, platformOf.get(gid) ?? '')
        alts++
      }
    )
    db.exec('COMMIT')
    db.exec(`CREATE INDEX IF NOT EXISTS ix_names ON names(platform, norm);
             CREATE INDEX IF NOT EXISTS ix_names_n ON names(norm);`)
    const meta = db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)')
    meta.run('updated', new Date().toISOString())
    meta.run('games', String(games))
    meta.run('alts', String(alts))
    db.exec('VACUUM')
    return { games, alts }
  } finally {
    db.close()
  }
}

/** Opens Metadata.xml inside the zip as a stream. */
export function openZipEntry(zipPath: string, entryName: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('zip'))
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) return zip.readEntry()
        zip.openReadStream(entry, (e, stream) => (e || !stream ? reject(e ?? new Error('entry')) : resolve(stream)))
      })
      zip.on('end', () => reject(new Error(`${entryName} not found in archive`)))
      zip.on('error', reject)
      zip.readEntry()
    })
  })
}
