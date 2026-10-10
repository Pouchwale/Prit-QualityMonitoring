import { eq } from 'drizzle-orm'
import { db, type Transaction } from '../db/client'
import { departmentMappings, departments } from '../db/schema'
import { badRequest } from '../lib/http'

/**
 * A job's department comes from its Item Code: the start of the Item Code (its prefix) names the
 * department, e.g. RMLA12345 -> Label, RMPO-001 -> Pouch, RMSL98765 -> Sleeve. Nobody picks the
 * department by hand, and a worker's own account never decides it.
 *
 * The mapping is kept in ONE place, the Department Configuration (department_mappings, edited on
 * the admin panel's Department Configuration page), and applied only here, in the backend: the apps
 * only show the department the backend worked out. A new prefix (e.g. RMXX for a new department) is
 * added there, with no code change.
 *
 * Matching ignores case and surrounding spaces ("rmla12345" is Label). Prefixes never overlap
 * (checkMappingPrefix), so at most one mapping matches; the longest prefix would win anyway. An
 * inactive mapping, or a mapping to an inactive department, matches but is refused: the Item Code
 * is not passed on to another department.
 */

export const UNKNOWN_ITEM_CODE_DEPARTMENT = 'Unable to determine the job department from this Item Code. Please check the Item Code.'

/** Item Codes are compared, and stored on jobs, in upper case without surrounding spaces. */
export const normalizeItemCode = (itemCode: string) => itemCode.trim().toUpperCase()

/** A prefix as stored: 2-20 upper-case letters, digits or hyphens, starting with a letter or digit. */
const PREFIX_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/

export interface ItemCodeDepartment {
  id: string
  code: string
  name: string
  /** The prefix that matched, e.g. "RMLA". */
  prefix: string
}

interface ItemCodeMatch extends ItemCodeDepartment {
  mappingActive: boolean
  departmentActive: boolean
}

type Db = Transaction | typeof db

/** The mapping an Item Code falls under, active or not, or null when no prefix matches. */
async function matchItemCode(itemCode: string | null | undefined, tx: Db): Promise<ItemCodeMatch | null> {
  const code = normalizeItemCode(itemCode ?? '')
  if (!code) return null
  const rows = await tx
    .select({
      prefix: departmentMappings.prefix,
      mappingActive: departmentMappings.isActive,
      id: departments.id,
      code: departments.code,
      name: departments.name,
      departmentActive: departments.isActive
    })
    .from(departmentMappings)
    .innerJoin(departments, eq(departments.id, departmentMappings.departmentId))
  let best: ItemCodeMatch | null = null
  for (const row of rows) {
    const prefix = row.prefix.toUpperCase()
    if (code.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) best = { ...row, prefix }
  }
  return best
}

/**
 * The department of a job with this Item Code. A job cannot be planned or started without one: 400,
 * with the reason (unknown prefix, inactive mapping or inactive department).
 */
export async function requireItemCodeDepartment(itemCode: string | null | undefined, tx: Db = db): Promise<ItemCodeDepartment> {
  const found = await matchItemCode(itemCode, tx)
  if (!found) throw badRequest(UNKNOWN_ITEM_CODE_DEPARTMENT)
  if (!found.mappingActive) {
    throw badRequest(`Item Code prefix ${found.prefix} (${found.name}) is inactive in Department Configuration, so this Item Code cannot be used for jobs or checks.`)
  }
  if (!found.departmentActive) {
    throw badRequest(`The ${found.name} department (Item Code prefix ${found.prefix}) is inactive, so this Item Code cannot be used for jobs or checks.`)
  }
  const { id, code, name, prefix } = found
  return { id, code, name, prefix }
}

/**
 * Cleans a prefix entered in Department Configuration (upper case, no spaces) and refuses one that
 * another mapping already uses, or that overlaps one (RM would swallow RMLA), so an Item Code can
 * only ever mean one department. Inactive mappings keep their prefix reserved.
 */
export async function checkMappingPrefix(raw: string, mappingId: string | null, tx: Db = db): Promise<string> {
  const prefix = raw.trim().toUpperCase()
  if (!PREFIX_PATTERN.test(prefix)) throw badRequest('Item Code prefix: use 2 to 20 letters or digits (hyphens allowed after the first).')
  const others = await tx
    .select({ id: departmentMappings.id, prefix: departmentMappings.prefix, isActive: departmentMappings.isActive, name: departments.name })
    .from(departmentMappings)
    .innerJoin(departments, eq(departments.id, departmentMappings.departmentId))
  for (const other of others) {
    if (other.id === mappingId) continue
    const theirs = other.prefix.toUpperCase()
    const state = other.isActive ? '' : ' (inactive)'
    // 400, not 409: the entry has to change; reloading would not help.
    if (prefix === theirs) throw badRequest(`Item Code prefix ${prefix} is already mapped to ${other.name}${state}.`)
    if (prefix.startsWith(theirs) || theirs.startsWith(prefix)) {
      throw badRequest(`Item Code prefix ${prefix} overlaps ${theirs}, which is mapped to ${other.name}${state}.`)
    }
  }
  return prefix
}
