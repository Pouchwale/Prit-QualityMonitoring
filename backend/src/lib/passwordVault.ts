import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Viewable passwords for the Super Admin.
 *
 * Sign-in still uses the one-way bcrypt hash. Next to it the password is stored encrypted
 * (AES-256-GCM) so the Super Admin can view it. The key is kept outside the database:
 *  - PASSWORD_VIEW_KEY in .env (base64, 32 bytes), or
 *  - the key file (PASSWORD_VIEW_KEY_FILE, default backend/secrets/password-view.key),
 *    created automatically the first time a password is stored.
 *
 * A copy of the database alone therefore does not reveal passwords; the key is needed too.
 * Back up the key file with the database: without it stored copies cannot be shown again
 * (signing in is unaffected, and setting a new password stores a readable copy again).
 */

const VERSION = 'v1'
let cachedKey: Buffer | null = null

function keyFilePath() {
  return path.resolve(process.cwd(), process.env.PASSWORD_VIEW_KEY_FILE ?? 'secrets/password-view.key')
}

function loadKey(create: boolean): Buffer | null {
  if (cachedKey) return cachedKey

  const fromEnv = process.env.PASSWORD_VIEW_KEY
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'base64')
    if (key.length !== 32) throw new Error('PASSWORD_VIEW_KEY must be 32 bytes, base64 encoded')
    return (cachedKey = key)
  }

  const file = keyFilePath()
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64')
    if (key.length !== 32) throw new Error(`The password-view key in ${file} is invalid`)
    return (cachedKey = key)
  }
  if (!create) return null

  const key = randomBytes(32)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // wx: never overwrite a key another process has just written.
  try {
    fs.writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' })
    console.log(`Created the password-view key at ${file}. Back it up together with the database.`)
    return (cachedKey = key)
  } catch {
    return loadKey(false)
  }
}

/** Encrypts a password for storage. */
export function encryptPassword(password: string): string {
  const key = loadKey(true)!
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':')
}

/** Decrypts a stored password, or returns null when it cannot be read (no copy, or key missing). */
export function decryptPassword(stored: string | null): string | null {
  if (!stored) return null
  const [version, iv, tag, data] = stored.split(':')
  if (version !== VERSION || !iv || !tag || !data) return null
  const key = loadKey(false)
  if (!key) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
