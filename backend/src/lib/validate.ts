import type { Request } from 'express'
import { z } from 'zod'
import { HHMM_REGEX } from './time'
import { badRequest } from './http'

export const idParam = (req: Request, name = 'id') => z.uuid('Invalid id').parse(req.params[name])

export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

/**
 * The one Item Code format: FGPO, FGLA or FGSL followed by digits, e.g. FGPO123. The worker app
 * (utils/itemCode.ts) and the admin panel (lib/itemCode.ts) copy this pattern and message.
 */
export const ITEM_CODE_PATTERN = /^(FGPO|FGLA|FGSL)\d+$/
export const ITEM_CODE_ERROR = 'Invalid Item Code. Only FGPO, FGLA, or FGSL followed by numbers are allowed. Example: FGPO123.'

/**
 * An Item Code as typed, trimmed and upper-cased ("fgpo123" -> "FGPO123"); empty stays empty.
 * Anything else that does not match is refused (400), never corrected.
 */
export function validItemCode(raw: string | null | undefined): string {
  const code = (raw ?? '').trim().toUpperCase()
  if (code && !ITEM_CODE_PATTERN.test(code)) throw badRequest(ITEM_CODE_ERROR)
  return code
}

/**
 * Exception reasons about the machine itself (stopped, maintenance, breakdown) need only the machine.
 * ponytail: matched on the admin-editable label; add a flag on exception_reasons if labels drift.
 */
export const isMachineReason = (reason: string) => /machine|maintenance|breakdown/i.test(reason)

/** Why an exception cannot be sent without its machine and PO No. / Item Code; null when all needed are there. */
export function exceptionDetailsError(machineId: string | null | undefined, poOrItemCode: string | null | undefined, machineOnly = false) {
  const machine = !!machineId?.trim()
  const po = !!poOrItemCode?.trim()
  if (machineOnly) return machine ? null : 'Machine Name is required for an Exception.'
  if (machine && po) return null
  if (!machine && !po) return 'Machine Name and PO No. / Item Code are required for an Exception.'
  return `${machine ? 'PO No. / Item Code' : 'Machine Name'} is required for an Exception.`
}

export const hhmm =z.string().regex(HHMM_REGEX, 'Use 24-hour time like 08:00')

export const optionalUuid = z
  .union([z.uuid(), z.literal(''), z.null()])
  .optional()
  .transform((v) => (v ? v : null))
