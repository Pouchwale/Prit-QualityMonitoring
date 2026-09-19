import { eq, max, sql } from 'drizzle-orm'
import { db } from './client'
import { activities, activityParameters, parameters, settings } from './schema'

/** Set once the parameters below have been added, so a parameter an admin later deletes stays deleted. */
const MARKER = 'parameters.added.2026-09'

type NewParameter = Pick<typeof parameters.$inferInsert, 'name' | 'code' | 'type' | 'unit' | 'options' | 'description'>

/**
 * Quality parameters added in September 2026. The dropdown options (Treatment, Shared Card) are
 * only the starting list: admins change them in Parameters like any other parameter.
 */
export const NEW_PARAMETERS: NewParameter[] = [
  { name: 'Film Size', code: 'FILM-SIZE', type: 'NUMBER', unit: 'mm', description: 'Film width in mm' },
  { name: 'Text Matter', code: 'TEXT-MATTER', type: 'PASS_FAIL', description: 'Printed text matches the approved artwork' },
  { name: 'Duration', code: 'DURATION', type: 'NUMBER', unit: 'min' },
  { name: 'Interval', code: 'INTERVAL', type: 'NUMBER', unit: 'min' },
  { name: 'Treatment', code: 'TREATMENT', type: 'DROPDOWN', options: ['BOPP 38', 'PET 56'], description: 'Film and treatment level' },
  {
    name: 'Shared Card',
    code: 'SHARED-CARD',
    type: 'DROPDOWN',
    options: ['GMB', 'Shared Card', 'Pantone', 'Party Special', 'Last Supply', 'Online Approval'],
    description: 'Colour reference used for this job'
  },
  { name: 'Ink Photo', code: 'INK-PHOTO', type: 'PHOTO', description: 'Photo of the ink reference' }
]

/**
 * Adds the new parameters to an existing database, once. Nothing existing is changed: a parameter
 * whose code or name is already used is skipped, and the new ones are added to every check type
 * as optional, with no photo, video or N/A rule, so no worker is blocked until an admin sets the
 * rules in Check Types. A new, empty database gets them from the seed instead.
 */
export async function ensureNewParameters() {
  const [done] = await db.select({ key: settings.key }).from(settings).where(eq(settings.key, MARKER)).limit(1)
  if (done) return 0
  const existing = await db.select({ name: parameters.name, code: parameters.code }).from(parameters)
  if (existing.length === 0) return 0

  return db.transaction(async (tx) => {
    const taken = new Set(existing.flatMap((p) => [p.name.trim().toLowerCase(), p.code.trim().toLowerCase()]))
    const missing = NEW_PARAMETERS.filter((p) => !taken.has(p.name.toLowerCase()) && !taken.has(p.code.toLowerCase()))

    let added: { id: string }[] = []
    if (missing.length) {
      const [{ last }] = await tx.select({ last: max(parameters.sortOrder) }).from(parameters)
      added = await tx
        .insert(parameters)
        .values(missing.map((p, i) => ({ ...p, isRequired: false, sortOrder: (last ?? -1) + 1 + i })))
        .onConflictDoNothing()
        .returning({ id: parameters.id })

      const checkTypes = added.length ? await tx.select({ id: activities.id }).from(activities) : []
      for (const activity of checkTypes) {
        const [{ last: lastInType }] = await tx
          .select({ last: max(activityParameters.sortOrder) })
          .from(activityParameters)
          .where(eq(activityParameters.activityId, activity.id))
        await tx
          .insert(activityParameters)
          .values(
            added.map((p, i) => ({
              activityId: activity.id,
              parameterId: p.id,
              isRequired: false,
              sortOrder: (lastInType ?? -1) + 1 + i
            }))
          )
          .onConflictDoNothing()
      }
    }

    await tx
      .insert(settings)
      .values({ key: MARKER, value: { added: added.length, at: new Date().toISOString() } })
      .onConflictDoUpdate({ target: settings.key, set: { updatedAt: sql`now()` } })
    return added.length
  })
}
