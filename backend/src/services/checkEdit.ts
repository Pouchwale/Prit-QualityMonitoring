import { createHash } from 'node:crypto'
import type { Request } from 'express'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/client'
import { activities, activityParameters, checkExceptions, exceptionReasons, parameters, qualityCheckValues, qualityChecks } from '../db/schema'
import { badRequest, conflict, notFound } from '../lib/http'
import { audit } from '../lib/audit'
import { validItemCode } from '../lib/validate'
import { emptyValue, isEmpty, PHOTO_VALUE, readingValue, ruleText } from './evaluate'
import { requireItemCodeDepartment } from './itemCodeDepartment'

/**
 * Super Admin corrections of a submitted check (routes/monitoring.ts). What can be corrected is what
 * the worker typed: the readings, the Item Code and PO No. (unless a job set them) and, on an
 * exception, the remark. Status, worker, machine, times, photos and Not Applicable choices stay as
 * submitted, so scoring and schedules are untouched; PASS / FAIL is worked out again from the
 * corrected readings with the same rules as a submission. Every correction is one audit log entry
 * (EDIT_CHECK) with the old and new values and the reason.
 */

type Db = typeof db

async function load(id: string, tx: Db) {
  const [check] = await tx.select().from(qualityChecks).where(eq(qualityChecks.id, id))
  if (!check) throw notFound('Quality check')
  const values = await tx.select().from(qualityCheckValues).where(eq(qualityCheckValues.checkId, id)).orderBy(asc(qualityCheckValues.sortOrder))
  const [exception] = await tx.select().from(checkExceptions).where(eq(checkExceptions.checkId, id))
  const [activity] = await tx.select().from(activities).where(eq(activities.id, check.activityId))
  const ids = values.map((v) => v.parameterId).filter((p): p is string => !!p)
  const params = ids.length ? await tx.select().from(parameters).where(inArray(parameters.id, ids)) : []
  return { check, values, exception: exception ?? null, activity, params: new Map(params.map((p) => [p.id, p])) }
}

type Loaded = Awaited<ReturnType<typeof load>>

/** A reading can be corrected when it is a typed reading of a parameter that still exists. */
const editableValue = (v: Loaded['values'][number], l: Loaded) =>
  !v.notApplicable && v.parameterType !== 'PHOTO' && v.value !== PHOTO_VALUE && !!v.parameterId && l.params.has(v.parameterId)

/** Changes whenever anything correctable changes, so a save over someone else's edit is refused. */
function versionOf(l: Loaded) {
  const state = [l.check.itemCode, l.check.jobNo, l.exception?.remark, ...l.values.map((v) => `${v.id}=${v.value}`)]
  return createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16)
}

/** What the edit form needs: the correctable fields, their current values and their rules. */
export async function checkEditForm(id: string) {
  const l = await load(id, db)
  if (l.check.status !== 'COMPLETED' && l.check.status !== 'EXCEPTION') {
    throw conflict('Only a completed check or an exception can be corrected.')
  }
  const jobSet = !!l.check.jobId
  return {
    id: l.check.id,
    code: l.check.code,
    status: l.check.status,
    version: versionOf(l),
    itemCode: l.check.itemCode ?? '',
    jobNo: l.check.jobNo ?? '',
    /** A job's check takes its Item Code and PO No. from the job: they are corrected on the job. */
    detailsEditable: !jobSet,
    remark: l.exception ? (l.exception.remark ?? '') : null,
    exceptionReason: l.exception?.reason ?? null,
    values: l.values.map((v) => {
      const p = v.parameterId ? l.params.get(v.parameterId) : undefined
      return {
        id: v.id,
        parameterName: v.parameterName,
        type: v.parameterType,
        unit: v.unit,
        rule: v.rule,
        value: v.value ?? '',
        result: v.result,
        notApplicable: v.notApplicable,
        editable: editableValue(v, l),
        options: p?.options ?? [],
        materialOptions: p?.materialOptions ?? [],
        multiSelect: p?.multiSelect ?? false
      }
    })
  }
}

export const checkEditInput = z.object({
  version: z.string().min(1),
  reason: z.string().trim().max(500).default(''),
  itemCode: z.string().trim().max(60).optional(),
  jobNo: z.string().trim().max(60).optional(),
  remark: z.string().trim().max(1000).optional(),
  values: z.array(z.object({ id: z.uuid(), value: z.string().max(500) })).max(100).default([])
})

/** Applies a correction in one transaction; refuses it when the check changed since the form loaded. */
export async function editCheck(req: Request, id: string, input: z.infer<typeof checkEditInput>) {
  return db.transaction(async (tx) => {
    // Locks the check, so two corrections at once are applied one after the other.
    await tx.select({ id: qualityChecks.id }).from(qualityChecks).where(eq(qualityChecks.id, id)).for('update')
    const l = await load(id, tx as unknown as Db)
    if (l.check.status !== 'COMPLETED' && l.check.status !== 'EXCEPTION') {
      throw conflict('Only a completed check or an exception can be corrected.')
    }
    if (input.version !== versionOf(l)) throw conflict('This check was changed by someone else. Reload it and try again.')

    const before: Record<string, unknown> = {}
    const after: Record<string, unknown> = {}

    // Readings: validated and judged PASS / FAIL like a submission, against the current limits.
    const byId = new Map(l.values.map((v) => [v.id, v]))
    const valueUpdates: { id: string; set: Partial<typeof qualityCheckValues.$inferInsert> }[] = []
    for (const entry of input.values) {
      const row = byId.get(entry.id)
      if (!row) throw badRequest('A reading does not belong to this check.')
      if ((row.value ?? '') === entry.value.trim()) continue
      if (!editableValue(row, l)) throw badRequest(`${row.parameterName} cannot be corrected here.`)
      const p = l.params.get(row.parameterId!)!
      const config = { name: p.name, type: p.type, unit: p.unit, minValue: p.minValue, maxValue: p.maxValue, options: p.options, materialOptions: p.materialOptions, multiSelect: p.multiSelect }
      // Required or not is set per check type, as on the worker's form.
      const [link] = await tx
        .select({ isRequired: activityParameters.isRequired })
        .from(activityParameters)
        .where(and(eq(activityParameters.activityId, l.check.activityId), eq(activityParameters.parameterId, p.id)))
      const required = link?.isRequired ?? p.isRequired
      let next: ReturnType<typeof readingValue> | ReturnType<typeof emptyValue>
      if (isEmpty(entry.value)) {
        if (required) throw badRequest(`${p.name} is required.`)
        next = emptyValue()
      } else {
        next = readingValue(config, entry.value)
      }
      before[row.parameterName] = { value: row.value, result: row.result }
      after[row.parameterName] = { value: next.value, result: next.result }
      valueUpdates.push({ id: row.id, set: { value: next.value, result: next.result, rule: ruleText(config) } })
    }

    // Item Code and PO No.: what the worker typed, unless a job set them.
    const checkSet: Partial<typeof qualityChecks.$inferInsert> = {}
    const wantsDetails = (input.itemCode !== undefined && input.itemCode !== (l.check.itemCode ?? '')) || (input.jobNo !== undefined && input.jobNo !== (l.check.jobNo ?? ''))
    if (wantsDetails) {
      if (l.check.jobId) throw badRequest("This check's Item Code and PO No. come from its job. Correct them on the job.")
      if (input.itemCode !== undefined && input.itemCode !== (l.check.itemCode ?? '')) {
        const itemCode = validItemCode(input.itemCode)
        before.itemCode = l.check.itemCode
        after.itemCode = itemCode || null
        checkSet.itemCode = itemCode || null
        // The department follows the corrected Item Code, as on a submission (jobs are excluded above).
        if (itemCode) {
          const department = await requireItemCodeDepartment(itemCode, tx)
          if (department.id !== l.check.departmentId) {
            before.departmentId = l.check.departmentId
            after.departmentId = department.id
            after.department = department.name
            checkSet.departmentId = department.id
          }
        }
      }
      if (input.jobNo !== undefined && input.jobNo !== (l.check.jobNo ?? '')) {
        if (!input.jobNo && l.activity?.requireJobNo && l.check.submissionType !== 'MANUAL' && l.check.status === 'COMPLETED') {
          throw badRequest('Enter the PO No.')
        }
        before.jobNo = l.check.jobNo
        after.jobNo = input.jobNo || null
        checkSet.jobNo = input.jobNo || null
      }
    }

    // Exception remark: still required when the exception's reason asks for one.
    let remark: string | null | undefined
    if (input.remark !== undefined && l.exception && input.remark !== (l.exception.remark ?? '')) {
      const [reasonRow] = await tx.select().from(exceptionReasons).where(eq(exceptionReasons.label, l.exception.reason))
      if (!input.remark && reasonRow?.requiresRemark) throw badRequest('Please write a remark')
      before.remark = l.exception.remark
      after.remark = input.remark || null
      remark = input.remark || null
    }

    if (!valueUpdates.length && !Object.keys(checkSet).length && remark === undefined) throw badRequest('Nothing was changed.')

    for (const u of valueUpdates) await tx.update(qualityCheckValues).set(u.set).where(eq(qualityCheckValues.id, u.id))
    if (valueUpdates.length && l.check.status === 'COMPLETED') {
      // The overall result follows the readings, exactly as at submission.
      const rows = await tx.select({ result: qualityCheckValues.result }).from(qualityCheckValues).where(eq(qualityCheckValues.checkId, id))
      const overall = rows.some((r) => r.result === 'FAIL') ? 'FAIL' : 'PASS'
      if (overall !== l.check.overallResult) {
        before.overallResult = l.check.overallResult
        after.overallResult = overall
        checkSet.overallResult = overall
      }
    }
    if (Object.keys(checkSet).length) await tx.update(qualityChecks).set(checkSet).where(eq(qualityChecks.id, id))
    if (remark !== undefined && l.exception) await tx.update(checkExceptions).set({ remark }).where(eq(checkExceptions.id, l.exception.id))

    await audit(req, 'EDIT_CHECK', 'QualityCheck', l.check.code, {
      oldValue: { checkId: id, ...before },
      newValue: { checkId: id, ...after, reason: input.reason || null }
    }, tx)
  })
}
