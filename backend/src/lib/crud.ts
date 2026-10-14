import { eq } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '../db/client'

function isForeignKeyError(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } }
  const code = e?.code ?? e?.cause?.code
  // 23503 = foreign_key_violation, 23001 = restrict_violation
  return code === '23503' || code === '23001'
}

/** Disables a record instead of deleting it. */
async function disable(table: PgTable & { id: PgColumn; isActive: PgColumn }, id: string) {
  await db
    .update(table)
    .set({ isActive: false } as never)
    .where(eq(table.id, id))
}

/**
 * Deletes a record. If other records still reference it (for example check history), the record is
 * disabled instead so history stays intact. Some references are "set null" in the database, which
 * would silently blank them on delete: `inUse` names those, and a record in use is disabled too.
 */
export async function deleteOrDisable(
  table: PgTable & { id: PgColumn; isActive: PgColumn },
  id: string,
  inUse?: () => Promise<boolean>,
  /**
   * Disabling is deactivating, which only the Super Admin may do (lib/activation.ts): for anyone
   * else `deny` is called instead (it throws), and the record stays as it is.
   */
  options: { canDisable: boolean; deny: () => Promise<never> } = { canDisable: true, deny: async () => { throw new Error('denied') } }
): Promise<'deleted' | 'disabled'> {
  const disableOrDeny = async () => {
    if (!options.canDisable) await options.deny()
    await disable(table, id)
    return 'disabled' as const
  }
  if (inUse && (await inUse())) return disableOrDeny()
  try {
    await db.delete(table).where(eq(table.id, id))
    return 'deleted'
  } catch (err) {
    if (!isForeignKeyError(err)) throw err
    return disableOrDeny()
  }
}
