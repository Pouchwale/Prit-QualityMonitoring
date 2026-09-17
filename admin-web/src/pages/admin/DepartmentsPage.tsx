import React, { useState } from 'react'
import { Edit2, Plus, Trash2 } from 'lucide-react'
import type { Department } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'

interface FormState {
  name: string
  code: string
  isActive: boolean
}

const emptyForm: FormState = { name: '', code: '', isActive: true }

export const DepartmentsPage: React.FC = () => {
  const canEdit = useCanManage('departments')
  const notify = useToast()
  const { data, error, loading, reload } = useApi<Department[]>('/api/departments')

  const [editing, setEditing] = useState<Department | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Department | null>(null)

  const departments = data ?? []

  const openNew = () => {
    setForm(emptyForm)
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (d: Department) => {
    setForm({ name: d.name, code: d.code, isActive: d.isActive })
    setFormError(null)
    setEditing(d)
  }

  const close = () => setEditing(null)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.code.trim()) {
      setFormError('Name and code are required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const body = { name: form.name.trim(), code: form.code.trim(), isActive: form.isActive }
      if (editing === 'new') {
        await api.post('/api/departments', body)
        notify('success', 'Department created', body.name)
      } else if (editing) {
        await api.put(`/api/departments/${editing.id}`, body)
        notify('success', 'Department updated', body.name)
      }
      setEditing(null)
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    try {
      const { result } = await api.del(`/api/departments/${deleting.id}`)
      if (result === 'disabled') {
        notify('warning', 'Department disabled', `${deleting.name} is in use, so it was marked inactive instead of deleted.`)
      } else {
        notify('success', 'Department deleted', deleting.name)
      }
      reload()
    } catch (err) {
      notify('error', 'Could not delete department', errorText(err))
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Departments"
        description="Plant departments used to group machines, check types and workers"
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Department
            </Button>
          )
        }
      />

      <DataState loading={loading} error={error} onRetry={reload} empty={!loading && departments.length === 0} emptyText="No departments yet">
        <div className="bg-white border border-line rounded-md shadow-2xs overflow-x-auto">
          <table className="stack-sm w-full text-left text-xs border-collapse">
            <thead className="bg-slate-50 border-b border-line text-ink-secondary font-mono text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2.5 px-3.5">Department</th>
                <th className="py-2.5 px-3.5">Code</th>
                <th className="py-2.5 px-3.5">Status</th>
                {canEdit && <th className="py-2.5 px-3.5 text-right">Action</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {departments.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50 transition-colors">
                  <td className="py-2.5 px-3.5 font-semibold text-ink whitespace-nowrap">{d.name}</td>
                  <td className="py-2.5 px-3.5 font-mono text-ink-secondary whitespace-nowrap">{d.code}</td>
                  <td className="py-2.5 px-3.5 whitespace-nowrap">
                    <StatusBadge status={d.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" />
                  </td>
                  {canEdit && (
                    <td className="py-2 px-3.5 text-right whitespace-nowrap">
                      <div className="inline-flex gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => openEdit(d)} icon={<Edit2 className="w-3 h-3 text-ink-muted" />}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(d)} title="Delete" aria-label={`Delete ${d.name}`} icon={<Trash2 className="w-3.5 h-3.5 text-failed" />} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add Department' : 'Edit Department'}
        maxWidth="sm"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="department-form" loading={saving}>
              {editing === 'new' ? 'Create Department' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="department-form" onSubmit={submit} className="space-y-3">
          <FormError message={formError} />
          <Field label="Name" required>
            <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Printing" maxLength={100} autoFocus />
          </Field>
          <Field label="Code" required>
            <TextInput value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="e.g. PRT" maxLength={30} className="font-mono" />
          </Field>
          <Toggle checked={form.isActive} onChange={(isActive) => setForm({ ...form, isActive })} label="Active" description="Inactive departments are hidden from selection lists." />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete department"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <span className="font-semibold text-ink">{deleting?.name}</span>? If machines, check types or users still belong to it, it
            will be marked inactive instead.
          </>
        }
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
