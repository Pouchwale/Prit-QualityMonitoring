import type { Request } from 'express'
import { z } from 'zod'
import { HHMM_REGEX } from './time'

export const idParam = (req: Request, name = 'id') => z.uuid('Invalid id').parse(req.params[name])

export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

export const hhmm = z.string().regex(HHMM_REGEX, 'Use 24-hour time like 08:00')

export const optionalUuid = z
  .union([z.uuid(), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null))
