// Parser for Valve's binary KeyValues format as used by userdata/<id>/config/shortcuts.vdf.
// Each entry: <type byte> <null-terminated key> <value>, where
//   0x00 = nested object (until 0x08), 0x01 = null-terminated UTF-8 string,
//   0x02 = 32-bit little-endian integer, 0x07 = 64-bit integer, 0x08 = end of object.
// Integers are returned as unsigned numbers (shortcut app ids use the full uint32 range).

export type BinVdfValue = string | number | BinVdfObject
export interface BinVdfObject {
  [key: string]: BinVdfValue
}

export class BinaryVdfError extends Error {}

export function parseBinaryVdf(buf: Buffer): BinVdfObject {
  let pos = 0

  const readString = (): string => {
    const end = buf.indexOf(0, pos)
    if (end < 0) throw new BinaryVdfError('Unterminated string')
    const s = buf.toString('utf8', pos, end)
    pos = end + 1
    return s
  }

  const readObject = (nested: boolean): BinVdfObject => {
    const obj: BinVdfObject = {}
    while (pos < buf.length) {
      const type = buf[pos++]
      if (type === 0x08) return obj
      const key = readString()
      switch (type) {
        case 0x00:
          obj[key] = readObject(true)
          break
        case 0x01:
          obj[key] = readString()
          break
        case 0x02:
          if (pos + 4 > buf.length) throw new BinaryVdfError('Truncated int32')
          obj[key] = buf.readUInt32LE(pos)
          pos += 4
          break
        case 0x07:
          if (pos + 8 > buf.length) throw new BinaryVdfError('Truncated int64')
          obj[key] = Number(buf.readBigUInt64LE(pos))
          pos += 8
          break
        default:
          throw new BinaryVdfError(`Unknown type 0x${type.toString(16)} at ${pos - 1}`)
      }
    }
    if (nested) throw new BinaryVdfError('Unexpected end of data')
    return obj
  }

  return readObject(false)
}

/** Case-insensitive property access (shortcuts.vdf mixes "appid"/"AppName"/"appname"). */
export function bget(obj: BinVdfObject | undefined, key: string): BinVdfValue | undefined {
  if (!obj) return undefined
  if (key in obj) return obj[key]
  const lower = key.toLowerCase()
  const k = Object.keys(obj).find((x) => x.toLowerCase() === lower)
  return k === undefined ? undefined : obj[k]
}
