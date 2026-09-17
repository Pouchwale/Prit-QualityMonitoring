import { eq } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import { db } from '../db/client'

function isForeignKeyError(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } }
  const code = e?.code ?? e?.cause?.code
  // 23503 = foreign_key_violation, 23001 = restrict_violation
  return code === '23503' || code === '23001'
}

/**
 * Deletes a record. If other records still reference it (for example check history),
 * the record is disabled instead so history stays intact.
 */
export async function deleteOrDisable(
  table: PgTable & { id: PgColumn; isActive: PgColumn },
  id: string
): Promise<'deleted' | 'disabled'> {
  try {
    await db.delete(table).where(eq(table.id, id))
    return 'deleted'
  } catch (err) {
    if (!isForeignKeyError(err)) throw err
    await db
      .update(table)
      .set({ isActive: false } as never)
      .where(eq(table.id, id))
    return 'disabled'
  }
}
