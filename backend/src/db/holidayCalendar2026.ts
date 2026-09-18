import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from './client'
import { plantClosures, settings } from './schema'
import { removeChecksIfClosed, removeChecksOnClosedDays } from '../services/plantCalendar'
import { invalidateCheckGeneration } from '../services/checkGenerator'

/**
 * Gujarat Print Pack Publication Pvt. Ltd. — Calendar 2026, loaded into the Plant Calendar.
 *
 * Source of truth: the company's printed 2026 calendar sheet (ગુજરાત પ્રિન્ટ પેક પબ્લિકેશન પ્રા.લી.
 * કેલેન્ડર ૨૦૨૬). Each holiday row may name an adjustment date (એડજસ્ટમેંટ તારીખ); the note on the
 * sheet says everyone must come to work on that day. Every adjustment date on the sheet is a
 * Thursday (ગુરુવાર), the plant's weekly off, so these entries open the plant on those Thursdays.
 *
 * Loaded once per database (settings keys below), so dates the admin later edits or removes are
 * not put back, and a date that already has an entry is left as the admin set it.
 */
const IMPORT_KEY = 'plant_calendar_import_gppl_2026'
// v2: v1 missed entries saved with the reason "Adjustment working day" by the first import.
const ADJUSTMENT_FIX_KEY = 'plant_calendar_fix_gppl_2026_adjustments_v2'

const HOLIDAYS: { date: string; name: string; adjustment?: string }[] = [
  { date: '2026-01-14', name: 'Uttarayan' },
  { date: '2026-01-26', name: 'Republic Day', adjustment: '2026-01-29' },
  { date: '2026-03-04', name: 'Dhuleti' },
  { date: '2026-08-15', name: 'Independence Day', adjustment: '2026-08-06' },
  { date: '2026-08-28', name: 'Rakshabandhan', adjustment: '2026-08-20' },
  { date: '2026-09-04', name: 'Janmashtami' },
  { date: '2026-10-19', name: 'Navratri Ashtami', adjustment: '2026-10-01' },
  { date: '2026-10-20', name: 'Navratri Nom', adjustment: '2026-10-08' },
  { date: '2026-11-09', name: 'Bestu Varas' },
  { date: '2026-11-10', name: 'Bhai Dooj' },
  { date: '2026-11-11', name: 'Padatar Divas', adjustment: '2026-10-22' },
  { date: '2026-11-12', name: 'Padatar Divas', adjustment: '2026-10-29' },
  { date: '2026-11-13', name: 'Padatar Divas', adjustment: '2026-11-05' }
]

const shortDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** Adjustment working days, each with the holiday it makes up for. */
const ADJUSTMENTS = HOLIDAYS.filter((h) => h.adjustment).map((h) => ({
  date: h.adjustment!,
  reason: `Adjustment for ${h.name} (${shortDate(h.date)})`
}))

/**
 * Adjustment dates loaded by the first version of this import, which were typed from a list
 * rather than read from the sheet: 28/01, 06/09, 20/09 and 27/10. The sheet has 29/01, 06/08,
 * 20/08 and 29/10.
 */
const WRONG_ADJUSTMENT_DATES = ['2026-01-28', '2026-09-06', '2026-09-20', '2026-10-27']

const rows = () => [
  ...HOLIDAYS.map((h) => ({ date: h.date, type: 'HOLIDAY' as const, reason: h.name })),
  ...ADJUSTMENTS.map((a) => ({ date: a.date, type: 'WORKING' as const, reason: a.reason }))
]

export async function importHolidayCalendar2026() {
  const [done] = await db.select().from(settings).where(eq(settings.key, IMPORT_KEY))
  if (done) return null

  const all = rows()
  const added = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(plantClosures)
      .values(all)
      .onConflictDoNothing({ target: plantClosures.date })
      .returning({ date: plantClosures.date, type: plantClosures.type })
    await tx.insert(settings).values({ key: IMPORT_KEY, value: { importedAt: new Date().toISOString(), holidays: HOLIDAYS.length, workingDays: ADJUSTMENTS.length } })
    // A new database already has the dates from the sheet; no correction needed later.
    await tx.insert(settings).values({ key: ADJUSTMENT_FIX_KEY, value: { appliedAt: new Date().toISOString(), note: 'not needed' } }).onConflictDoNothing()
    return inserted
  })

  // Holidays that were added: nothing on those dates may stay open or be marked Missed.
  const holidayDates = added.filter((r) => r.type === 'HOLIDAY').map((r) => r.date)
  const removedChecks = await removeChecksOnClosedDays(holidayDates)
  invalidateCheckGeneration()

  const skipped = all.length - added.length
  console.log(
    `Plant Calendar: added the 2026 company calendar (${holidayDates.length} holidays, ${added.length - holidayDates.length} adjustment working days)` +
      `${skipped ? `; ${skipped} date(s) already in the calendar were left unchanged` : ''}${removedChecks ? `; ${removedChecks} unsubmitted check(s) on holidays removed` : ''}.`
  )
  return { added: added.length, skipped, removedChecks }
}

/**
 * Corrects databases that loaded the first version of the 2026 calendar (runs once):
 *  - removes the wrongly typed adjustment dates, only where the entry is still exactly as the
 *    import created it (Adjustment Working Day, not created by a user, with the import's reason:
 *    none or "Adjustment working day");
 *  - adds the adjustment dates from the sheet, with the holiday each one makes up for;
 *  - fills in that reason on imported adjustment dates that were already right.
 * Dates an admin created or changed are left alone.
 */
export async function fixHolidayCalendar2026Adjustments() {
  const [done] = await db.select().from(settings).where(eq(settings.key, ADJUSTMENT_FIX_KEY))
  if (done) return null

  const result = await db.transaction(async (tx) => {
    const imported = and(
      eq(plantClosures.type, 'WORKING'),
      isNull(plantClosures.createdById),
      or(isNull(plantClosures.reason), eq(plantClosures.reason, 'Adjustment working day'))
    )
    const removed = await tx
      .delete(plantClosures)
      .where(and(inArray(plantClosures.date, WRONG_ADJUSTMENT_DATES), imported))
      .returning({ date: plantClosures.date })
    const added = await tx
      .insert(plantClosures)
      .values(ADJUSTMENTS.map((a) => ({ date: a.date, type: 'WORKING' as const, reason: a.reason })))
      .onConflictDoNothing({ target: plantClosures.date })
      .returning({ date: plantClosures.date })
    let labelled = 0
    for (const a of ADJUSTMENTS) {
      const rows = await tx
        .update(plantClosures)
        .set({ reason: a.reason, updatedAt: new Date() })
        .where(and(eq(plantClosures.date, a.date), imported))
        .returning({ date: plantClosures.date })
      labelled += rows.length
    }
    await tx.insert(settings).values({
      key: ADJUSTMENT_FIX_KEY,
      value: { appliedAt: new Date().toISOString(), removed: removed.map((r) => r.date), added: added.map((r) => r.date) }
    })
    return { removed: removed.map((r) => r.date), added: added.map((r) => r.date), labelled }
  })

  // The added Thursdays open the plant; a removed date only loses checks if it is now closed.
  invalidateCheckGeneration()
  const closedAgain = await removeChecksIfClosed(result.removed)
  if (result.removed.length || result.added.length || result.labelled) {
    console.log(
      `Plant Calendar: 2026 adjustment dates corrected from the company sheet — removed ${result.removed.join(', ') || 'none'}, ` +
        `added ${result.added.join(', ') || 'none'}, ${result.labelled} labelled${closedAgain ? `; ${closedAgain} check(s) removed` : ''}.`
    )
  }
  return { ...result, closedAgain }
}
