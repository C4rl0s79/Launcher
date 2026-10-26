import { DatabaseSync } from 'node:sqlite'
import type { Readable } from 'node:stream'
import sax from 'sax'
import yauzl from 'yauzl'
import { normTitle } from './match'
import { STORED_TYPES } from './images'

// Builds the local LaunchBox database from Metadata.zip (LaunchBox Games DB dump).
// Same schema as EmuStart's launchbox.db (games / names / images / meta), minus MAME sets which
// Lumen does not use; images only of the types Lumen shows. Runs inside a worker thread (worker.ts).

/** bump when the schema changes — an older database is rebuilt (service.ts) */
export const SCHEMA_VERSION = 3 // 3: ESRB, co-op, release type, number of ratings

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
  /** community ratings counted in `rating` */
  ratingCount: string
  esrb: string
  /** "true" / "false" */
  coop: string
  /** Released, Homebrew, Unlicensed, Early Access… */
  releaseType: string
}

export interface LbImageRow {
  gid: number
  type: string
  region: string
  fn: string
}

/**
 * Streams Metadata.xml and reports <Game>, <GameAlternateName> and <GameImage> records.
 * Only the fields we use are collected; everything else is skipped without buffering.
 */
export function parseMetadataXml(
  input: Readable,
  onGame: (g: LbGameRow) => void,
  onAltName: (gameId: number, name: string) => void,
  onImage: (img: LbImageRow) => void = () => undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: false })
    let record: 'Game' | 'GameAlternateName' | 'GameImage' | null = null
    let field: string | null = null
    let text = ''
    let cur: Record<string, string> = {}

    parser.on('opentag', (node) => {
      if (!record && (node.name === 'Game' || node.name === 'GameAlternateName' || node.name === 'GameImage')) {
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
              rating: (cur.CommunityRating ?? '').trim(),
              ratingCount: (cur.CommunityRatingCount ?? '').trim(),
              esrb: (cur.ESRB ?? '').trim(),
              coop: (cur.Cooperative ?? '').trim(),
              releaseType: (cur.ReleaseType ?? '').trim()
            })
          }
        } else if (record === 'GameImage') {
          const gid = Number(cur.DatabaseID)
          const type = (cur.Type ?? '').trim()
          if (gid && cur.FileName && STORED_TYPES.has(type)) onImage({ gid, type, region: (cur.Region ?? '').trim(), fn: cur.FileName.trim() })
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
    players TEXT, rating TEXT, rating_count TEXT, esrb TEXT, coop TEXT, release_type TEXT);
CREATE TABLE IF NOT EXISTS names(norm TEXT, gid INTEGER, platform TEXT);
CREATE TABLE IF NOT EXISTS images(gid INTEGER, type TEXT, region TEXT, fn TEXT);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`

/** Writes parsed records into a fresh SQLite file. Returns counts. */
export async function buildDatabase(
  xml: Readable,
  outPath: string,
  progress: (games: number) => void = () => undefined
): Promise<{ games: number; alts: number; images: number }> {
  const db = new DatabaseSync(outPath)
  try {
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;')
    db.exec(SCHEMA)
    const insGame = db.prepare('INSERT OR REPLACE INTO games VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const insName = db.prepare('INSERT INTO names VALUES(?,?,?)')
    const insImage = db.prepare('INSERT INTO images VALUES(?,?,?,?)')
    const platformOf = new Map<number, string>()
    let games = 0
    let alts = 0
    let images = 0
    db.exec('BEGIN')
    await parseMetadataXml(
      xml,
      (g) => {
        insGame.run(
          g.id,
          g.name,
          g.platform,
          g.year,
          g.overview,
          g.developer,
          g.publisher,
          g.genres,
          g.players,
          g.rating,
          g.ratingCount,
          g.esrb,
          g.coop,
          g.releaseType
        )
        insName.run(normTitle(g.name), g.id, g.platform)
        platformOf.set(g.id, g.platform)
        if (++games % 5000 === 0) progress(games)
      },
      (gid, name) => {
        insName.run(normTitle(name), gid, platformOf.get(gid) ?? '')
        alts++
      },
      (img) => {
        insImage.run(img.gid, img.type, img.region, img.fn)
        images++
      }
    )
    db.exec('COMMIT')
    db.exec(`CREATE INDEX IF NOT EXISTS ix_names ON names(platform, norm);
             CREATE INDEX IF NOT EXISTS ix_names_n ON names(norm);
             CREATE INDEX IF NOT EXISTS ix_images ON images(gid);`)
    const meta = db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)')
    meta.run('updated', new Date().toISOString())
    meta.run('games', String(games))
    meta.run('alts', String(alts))
    meta.run('images', String(images))
    meta.run('schema', String(SCHEMA_VERSION))
    db.exec('VACUUM')
    return { games, alts, images }
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
