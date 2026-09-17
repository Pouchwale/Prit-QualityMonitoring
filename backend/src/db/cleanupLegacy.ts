import { eq } from 'drizzle-orm'
import { db } from './client'
import { settings } from './schema'

/**
 * Earlier versions seeded a demo plant name, "Unit 1 — Flexible Packaging", which then
 * appeared in the Admin header, the sidebar and the report letterhead. It is not a real
 * label for this plant, so it is removed from databases that were seeded with it.
 *
 * Only that exact demo value is removed. A plant name an admin has typed in
 * Settings is left alone, and no machines, workers, assignments or checks are touched.
 */
const LEGACY_PLANT_NAMES = ['Unit 1 — Flexible Packaging', 'Unit 1 - Flexible Packaging']

export async function removeLegacyPlantLabel() {
  const [row] = await db.select().from(settings).where(eq(settings.key, 'plant')).limit(1)
  if (!row) return false

  const name = (row.value as { name?: unknown } | null)?.name
  if (typeof name !== 'string' || !LEGACY_PLANT_NAMES.includes(name.trim())) return false

  await db.delete(settings).where(eq(settings.key, 'plant'))
  console.log(`Removed the demo plant label "${name}" from Settings.`)
  return true
}
