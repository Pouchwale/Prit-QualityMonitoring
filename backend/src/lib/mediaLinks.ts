import path from 'node:path'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Express } from 'express'
import { config } from '../config'

/**
 * Evidence photos and videos are never public. A file is only reachable through a signed,
 * short-lived link, and links are only handed out inside API responses that already checked the
 * caller's permissions (e.g. a check the user may view). Signed links work in <img>/<video> tags,
 * the web panel, the mobile app and CSV exports, which cannot send an Authorization header.
 */

const LINK_TTL_SECONDS = 12 * 60 * 60
const secret = process.env.MEDIA_LINK_SECRET ?? createHmac('sha256', config.jwtAccessSecret).update('media-links').digest('hex')

const sign = (relativePath: string, exp: number) => createHmac('sha256', secret).update(`${relativePath}\n${exp}`).digest('base64url')

/** A link to a stored file, valid for 12 hours. */
export function signedMediaUrl(relativePath: string, ttlSeconds = LINK_TTL_SECONDS) {
  // Round the expiry so repeated responses produce the same URL (browser caching).
  const exp = Math.ceil((Date.now() / 1000 + ttlSeconds) / 600) * 600
  const encoded = relativePath.split('/').map(encodeURIComponent).join('/')
  return `/media/${encoded}?exp=${exp}&sig=${sign(relativePath, exp)}`
}

/** The stored path inside a signed link, for server-side use such as the PDF report. */
export function mediaPathFromUrl(url: string) {
  const match = /^\/media\/([^?]+)/.exec(url)
  return match ? match[1].split('/').map(decodeURIComponent).join('/') : null
}

export function serveSignedMedia(app: Express) {
  const root = path.resolve(config.uploadDir)
  app.get(/^\/media\/(.+)$/, (req, res) => {
    const relativePath = decodeURIComponent((req.params as unknown as string[])[0] ?? '')
    const exp = Number(req.query.exp)
    const sig = typeof req.query.sig === 'string' ? req.query.sig : ''
    const expected = Number.isFinite(exp) ? sign(relativePath, exp) : ''
    const valid =
      sig.length === expected.length && expected.length > 0 && timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) && exp * 1000 > Date.now()
    const full = path.resolve(root, relativePath)
    if (!valid || !full.startsWith(root + path.sep)) {
      res.status(403).json({ error: 'This link has expired or is not valid. Open the check again to view its evidence.' })
      return
    }
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.sendFile(full, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'File not found' })
    })
  })
}
