// Signs release files for Lumen's updater: writes <file>.sig next to each file.
//   node scripts/sign-release.mjs release/Lumen-1.2.3-win64.zip release/Lumen-1.2.3-setup.exe …
// Private key (Ed25519, PKCS#8 PEM): LUMEN_SIGNING_KEY_FILE, default D:\GIT\_klucze\launcher-release-ed25519.pem.
// Never commit the private key. The public key is in src/main/releaseSigning.ts (RELEASE_PUBKEY).
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const keyFile = process.env.LUMEN_SIGNING_KEY_FILE || 'D:\\GIT\\_klucze\\launcher-release-ed25519.pem'
const priv = createPrivateKey(readFileSync(keyFile))
const pubRaw = createPublicKey(priv).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
const embedded = /RELEASE_PUBKEY = '([^']+)'/.exec(readFileSync(new URL('../src/main/releaseSigning.ts', import.meta.url), 'utf8'))?.[1]
if (pubRaw !== embedded) throw new Error(`Klucz ${keyFile} nie pasuje do RELEASE_PUBKEY w src/main/releaseSigning.ts`)

for (const file of process.argv.slice(2)) {
  const name = path.basename(file)
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex')
  const msg = Buffer.from(`lumen-release-v1\n${name}\n${sha}`, 'utf8')
  const sig = sign(null, msg, priv)
  if (!verify(null, msg, createPublicKey(priv), sig)) throw new Error(`podpis ${name} nie przeszedł weryfikacji`)
  writeFileSync(file + '.sig', sig.toString('base64') + '\n')
  console.log(`${name}.sig  sha256=${sha}`)
}
