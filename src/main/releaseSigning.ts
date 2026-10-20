import { createPublicKey, verify } from 'node:crypto'

// Release signatures (Ed25519), as in EmuStart (emustart/signing.py): GitHub's SHA-256 only proves
// the download is intact; whoever takes over the account could replace file and checksum. The
// private key is kept by the owner (scripts/sign-release.mjs); Lumen checks with this public key.
//
// Signed message: "lumen-release-v1\n<file name>\n<sha256 hex>" — a signature fits one file only
// (an older release cannot be passed off as a newer one). Signature file: <file>.sig (base64).

export const RELEASE_PUBKEY = 'gis/vRWXJshCMlZp3OuqsZdZsMddRf4ugNsV4v6E9g8='

export function releaseMessage(name: string, sha256Hex: string): Buffer {
  return Buffer.from(`lumen-release-v1\n${name}\n${sha256Hex.toLowerCase()}`, 'utf8')
}

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export function verifyRelease(name: string, sha256Hex: string, sigB64: string, publicB64: string = RELEASE_PUBKEY): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicB64, 'base64')]), format: 'der', type: 'spki' })
    return verify(null, releaseMessage(name, sha256Hex), key, Buffer.from(sigB64.trim(), 'base64'))
  } catch {
    return false
  }
}
