import type { ErrorRequestHandler } from 'express'
import { ZodError } from 'zod'

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

export const badRequest = (message: string) => new HttpError(400, message)
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`)
export const conflict = (message: string) => new HttpError(409, message)

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code ?? e?.cause?.code
}

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  if (err instanceof ZodError) {
    const first = err.issues[0]
    const field = first?.path.join('.')
    res.status(400).json({ error: field ? `${field}: ${first.message}` : first?.message ?? 'Invalid input' })
    return
  }
  if (err?.name === 'MulterError') {
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message })
    return
  }
  const code = pgCode(err)
  if (code === '23505') {
    res.status(409).json({ error: 'A record with the same code or name already exists' })
    return
  }
  if (code === '23503' || code === '23001') {
    res.status(409).json({ error: 'This record is in use by other records' })
    return
  }
  console.error(err)
  res.status(500).json({ error: 'Something went wrong on the server' })
}
