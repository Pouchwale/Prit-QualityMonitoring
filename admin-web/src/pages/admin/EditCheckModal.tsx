import React, { useEffect, useState } from 'react'
import { api, errorText } from '../../lib/api'
import { itemCodeError } from '../../lib/itemCode'
import { Modal } from '../../components/common/Modal'
import { Button } from '../../components/common/Button'
import { Field, Select, TextArea, TextInput } from '../../components/common/Form'

/** GET /api/quality-checks/:id/edit (backend services/checkEdit.ts). */
interface EditForm {
  id: string
  code: string
  status: 'COMPLETED' | 'EXCEPTION'
  version: string
  itemCode: string
  jobNo: string
  detailsEditable: boolean
  remark: string | null
  exceptionReason: string | null
  values: {
    id: string
    parameterName: string
    type: string
    unit: string | null
    rule: string | null
    value: string
    notApplicable: boolean
    editable: boolean
    options: string[]
    materialOptions: string[]
    multiSelect: boolean
  }[]
}

/**
 * Super Admin correction of a submitted check: the readings, Item Code / PO No. and an exception's
 * remark. The server checks every value with the submission rules, works out PASS / FAIL again and
 * writes the old and new values with the reason to the audit log.
 */
export const EditCheckModal: React.FC<{ checkId: string | null; onClose: () => void; onSaved: () => void }> = ({ checkId, onClose, onSaved }) => {
  const [form, setForm] = useState<EditForm | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [itemCode, setItemCode] = useState('')
  const [jobNo, setJobNo] = useState('')
  const [remark, setRemark] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!checkId) return
    setForm(null)
    setError(null)
    setReason('')
    api
      .get<EditForm>(`/api/quality-checks/${checkId}/edit`)
      .then((f) => {
        setForm(f)
        setValues(Object.fromEntries(f.values.map((v) => [v.id, v.value])))
        setItemCode(f.itemCode)
        setJobNo(f.jobNo)
        setRemark(f.remark ?? '')
      })
      .catch((err) => setError(errorText(err)))
  }, [checkId])

  const codeError = form?.detailsEditable ? itemCodeError(itemCode) : null

  const save = async () => {
    if (!form || saving || codeError) return
    setSaving(true)
    setError(null)
    try {
      await api.put(`/api/quality-checks/${form.id}`, {
        version: form.version,
        reason,
        values: form.values.filter((v) => v.editable).map((v) => ({ id: v.id, value: values[v.id] ?? '' })),
        ...(form.detailsEditable ? { itemCode, jobNo } : {}),
        ...(form.remark !== null ? { remark } : {})
      })
      onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const input = (v: EditForm['values'][number]) => {
    const value = values[v.id] ?? ''
    const set = (next: string) => setValues((prev) => ({ ...prev, [v.id]: next }))
    const choices = v.type === 'PASS_FAIL' ? ['PASS', 'FAIL'] : v.type === 'YES_NO' ? ['YES', 'NO'] : v.type === 'DROPDOWN' && !v.multiSelect && !v.materialOptions.length ? v.options : null
    if (choices) {
      return (
        <Select value={value} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {/* An old value no longer offered stays selectable, so opening the form changes nothing. */}
          {value && !choices.includes(value) ? <option value={value}>{value}</option> : null}
          {choices.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      )
    }
    return <TextInput value={value} onChange={(e) => set(e.target.value)} inputMode={v.type === 'NUMBER' ? 'decimal' : undefined} maxLength={500} />
  }

  return (
    <Modal
      isOpen={!!checkId}
      onClose={() => !saving && onClose()}
      title="Correct quality check"
      subtitle={form ? `${form.code} · every change is recorded in the audit log` : undefined}
      maxWidth="xl"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} loading={saving} disabled={!form || !!codeError}>
            Save Changes
          </Button>
        </div>
      }
    >
      {!form ? (
        error ? <p className="text-sm text-danger">{error}</p> : <p className="text-sm text-ink-muted">Loading…</p>
      ) : (
        <div className="space-y-4">
          {form.values.map((v) => (
            <Field
              key={v.id}
              label={`${v.parameterName}${v.unit ? ` (${v.unit})` : ''}`}
              hint={
                !v.editable
                  ? v.notApplicable
                    ? 'Marked Not Applicable by the worker: cannot be corrected here.'
                    : 'Photo or removed parameter: cannot be corrected here.'
                  : [v.rule ? `Rule: ${v.rule}` : null, v.multiSelect || v.materialOptions.length ? `Options: ${[...v.materialOptions, ...v.options].join(', ')} (comma-separated)` : null]
                      .filter(Boolean)
                      .join(' · ') || undefined
              }
            >
              {v.editable ? input(v) : <TextInput value={v.notApplicable ? 'Not Applicable' : v.value || '—'} disabled readOnly />}
            </Field>
          ))}
          {form.detailsEditable ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Item Code" error={codeError ?? undefined}>
                <TextInput value={itemCode} onChange={(e) => setItemCode(e.target.value)} className="font-mono" maxLength={60} />
              </Field>
              <Field label="PO No.">
                <TextInput value={jobNo} onChange={(e) => setJobNo(e.target.value)} className="font-mono" maxLength={60} />
              </Field>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Item Code {form.itemCode || '—'} · PO No. {form.jobNo || '—'} come from the job and are corrected there.</p>
          )}
          {form.remark !== null ? (
            <Field label={`Exception remark (${form.exceptionReason})`}>
              <TextArea value={remark} onChange={(e) => setRemark(e.target.value)} rows={2} maxLength={1000} />
            </Field>
          ) : null}
          <Field label="Reason for the correction" hint="Saved in the audit log with the old and new values.">
            <TextArea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} placeholder="e.g. Worker typed 220 instead of 22" />
          </Field>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
        </div>
      )}
    </Modal>
  )
}
