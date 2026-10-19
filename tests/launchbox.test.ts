import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { normTitle, numbersMatch, platformForTags, similarity } from '../src/main/launchbox/match'
import { buildDatabase, parseMetadataXml, type LbGameRow } from '../src/main/launchbox/builder'
import { findGame, toDetails } from '../src/main/launchbox/lookup'

const XML = `<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Game>
    <Name>Ace Combat 5: The Unsung War</Name>
    <ReleaseYear>2004</ReleaseYear>
    <Overview>Air combat &amp; flight.
Second paragraph.</Overview>
    <MaxPlayers>2</MaxPlayers>
    <DatabaseID>3912</DatabaseID>
    <Platform>Sony Playstation 2</Platform>
    <Developer>Project Aces</Developer>
    <Publisher>Namco</Publisher>
    <Genres>Flight Simulator; Shooter</Genres>
    <CommunityRating>4.2874</CommunityRating>
  </Game>
  <Game>
    <Name>Ace Combat 5: The Unsung War</Name>
    <DatabaseID>421734</DatabaseID>
    <Platform>Sony Playstation 4</Platform>
  </Game>
  <Game>
    <Name>Final Fantasy X</Name>
    <ReleaseDate>2001-07-19T02:00:00+02:00</ReleaseDate>
    <DatabaseID>10</DatabaseID>
    <Platform>Sony Playstation 2</Platform>
    <Overview><![CDATA[Tidus <3]]></Overview>
  </Game>
  <Game>
    <Name>Final Fantasy X-2</Name>
    <DatabaseID>11</DatabaseID>
    <Platform>Sony Playstation 2</Platform>
  </Game>
  <Game>
    <Name>The Legend of Zelda: The Wind Waker</Name>
    <DatabaseID>20</DatabaseID>
    <Platform>Nintendo GameCube</Platform>
  </Game>
  <GameAlternateName>
    <AlternateName>Zelda no Densetsu: Kaze no Takuto</AlternateName>
    <DatabaseID>20</DatabaseID>
    <Region>Japan</Region>
  </GameAlternateName>
  <Platform><Name>Sony Playstation 2</Name></Platform>
</LaunchBox>`

describe('title matching helpers (EmuStart rules)', () => {
  it('normalises articles, tags and punctuation', () => {
    expect(normTitle('Legend of Zelda, The - Ocarina of Time (USA)')).toBe(normTitle('The Legend of Zelda: Ocarina of Time'))
    expect(normTitle('Ratchet & Clank')).toBe('ratchetandclank')
    expect(normTitle('Ace Combat 04 - Shattered Skies')).toBe(normTitle('Ace Combat 04: Shattered Skies'))
  })

  it('requires the same sequel numbers', () => {
    expect(numbersMatch('Final Fantasy X', 'Final Fantasy 10')).toBe(true)
    expect(numbersMatch('Part 3', 'Part II')).toBe(false)
    expect(numbersMatch('Ace Combat 5: The Unsung War', 'Ace Combat 5')).toBe(true)
  })

  it('scores similarity with bigrams', () => {
    expect(similarity('abc', 'abc')).toBe(1)
    expect(similarity('Final Fantasy X', 'Kingdom Hearts')).toBeLessThan(0.3)
  })

  it('maps Steam ROM Manager tags to LaunchBox platforms', () => {
    expect(platformForTags(['Non-Steam', 'PS2'])).toBe('Sony Playstation 2')
    expect(platformForTags(['GCN'])).toBe('Nintendo GameCube')
    expect(platformForTags(['DC'])).toBe('Sega Dreamcast')
    expect(platformForTags(['PS1'])).toBe('Sony Playstation')
    expect(platformForTags(['Favourites'])).toBeUndefined()
  })
})

describe('LaunchBox database', () => {
  it('streams games and alternate names out of Metadata.xml', async () => {
    const games: LbGameRow[] = []
    const alts: [number, string][] = []
    await parseMetadataXml(Readable.from([XML.slice(0, 300), XML.slice(300)]), (g) => games.push(g), (id, n) => alts.push([id, n]))
    expect(games).toHaveLength(5)
    expect(games[0]).toMatchObject({ id: 3912, platform: 'Sony Playstation 2', year: '2004', overview: 'Air combat & flight.\nSecond paragraph.' })
    expect(games[2]).toMatchObject({ year: '2001', overview: 'Tidus <3' })
    expect(alts).toEqual([[20, 'Zelda no Densetsu: Kaze no Takuto']])
  })

  it('builds a database that finds the right game per platform', async () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'lumen-lb-')), 'launchbox.db')
    expect(await buildDatabase(Readable.from([XML]), out)).toEqual({ games: 5, alts: 1 })
    const db = new DatabaseSync(out, { readOnly: true })
    try {
      expect(findGame(db, 'Ace Combat 5 - The Unsung War', 'Sony Playstation 2')?.id).toBe(3912)
      expect(findGame(db, 'Final Fantasy X', 'Sony Playstation 2')?.id).toBe(10) // not X-2
      expect(findGame(db, 'Final Fantasy X-2', 'Sony Playstation 2')?.id).toBe(11)
      expect(findGame(db, 'Zelda no Densetsu - Kaze no Takuto', 'Nintendo GameCube')?.id).toBe(20) // alternate name
      expect(findGame(db, 'Ace Combat 5: The Unsung War', 'Sega Dreamcast')).toBeNull()
      expect(findGame(db, 'Completely Unknown Game', undefined)).toBeNull()
      // series / subtitle after " - " in the shortcut name
      expect(findGame(db, 'Final Fantasy X - Square Collection', 'Sony Playstation 2')?.id).toBe(10)
      expect(findGame(db, 'Some Series - Unknown Thing', 'Sony Playstation 2')).toBeNull()

      const d = toDetails(findGame(db, 'Ace Combat 5: The Unsung War', 'Sony Playstation 2')!)
      expect(d).toMatchObject({
        source: 'launchbox',
        genres: ['Flight Simulator', 'Shooter'],
        developers: ['Project Aces'],
        publishers: ['Namco'],
        releaseDate: '2004',
        players: '2',
        rating: 4.3,
        platform: 'Sony Playstation 2'
      })
      expect(d.descriptionText).toContain('Second paragraph.')
    } finally {
      db.close()
    }
  })
})
