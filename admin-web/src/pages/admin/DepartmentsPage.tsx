import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Building2, Pencil, Plus, Tags, Trash2 } from 'lucide-react'
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
import { NAV_PATH } from '../../lib/routes'
import { Card, EmptyState } from '../../components/ui/Card'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { CodeChip, matchesStatus, type StatusTab } from '../../components/ui/Chips'

interface FormState {
  name: string
  code: string
  isActive: boolean
}

const emptyForm: FormState = { name: '', code: '', isActive: true }

/**
 * Departments. The Item Code prefixes that decide which department a job belongs to are shown here
 * read only; they are set on the Department Configuration page.
 */
export const DepartmentsPage: React.FC = () => {
  const canEdit = useCanManage('departments')
  const notify = useToast()
  const { data, error, loading, reload } = useApi<Department[]>('/api/departments')

  const [editing, setEditing] = useState<Department | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<Department | null>(null)

  const departments = useMemo(() => data ?? [], [data])
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<StatusTab>('ALL')
  const activeCount = departments.filter((d) => d.isActive).length
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return departments.filter(
      (d) => matchesStatus(status, d.isActive) && (!q || [d.name, d.code, ...(d.itemCodePrefixes ?? [])].some((v) => v.toLowerCase().includes(q)))
    )
  }, [departments, search, status])

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
    <div className="space-y-5">
      <PageHeader
        icon={<Building2 className="w-4.5 h-4.5" />}
        title="Departments"
        description={data ? `${departments.length} ${departments.length === 1 ? 'department' : 'departments'} · ${activeCount} active` : 'Plant departments'}
        info="Plant departments used to group machines, check types and workers. The Item Code prefixes that decide a job's department are set in Department Configuration."
        actions={
          <>
            <Link
              to={NAV_PATH['department-config']}
              className="inline-flex items-center gap-1.5 h-[36px] lg:h-[30px] px-3 lg:px-2.5 rounded-md text-[13px] lg:text-[12.5px] font-medium text-ink-secondary hover:bg-subtle hover:text-ink"
            >
              <Tags className="w-3.5 h-3.5" aria-hidden />
              Item Code prefixes
              <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </Link>
            {canEdit && (
              <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
                Add Department
              </Button>
            )}
          </>
        }
      />

      <DataState loading={loading} error={error} onRetry={reload} empty={data ? false : undefined}>
        <Card className="overflow-hidden">
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} label="Search departments" placeholder="Name, code or prefix…" />
            <Segmented<StatusTab>
              label="Filter by status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'ALL', label: 'All', count: departments.length },
                { value: 'ACTIVE', label: 'Active', count: activeCount },
                { value: 'INACTIVE', label: 'Inactive', count: departments.length - activeCount }
              ]}
            />
            <ToolbarSpacer />
            <ResultCount shown={filtered.length} total={departments.length} noun={departments.length === 1 ? 'department' : 'departments'} />
          </Toolbar>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Building2 className="w-5 h-5" />}
              title={departments.length === 0 ? 'No departments yet' : 'No departments match the filters'}
              action={
                departments.length === 0 && canEdit ? (
                  <Button size="sm" variant="outline" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
                    Add Department
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Department</th>
                    <th>Code</th>
                    <th>Active Item Code prefixes</th>
                    <th>Status</th>
                    {canEdit && (
                      <th className="text-right">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id}>
                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-2.5">
                          <span className="hidden md:flex w-7 h-7 shrink-0 rounded-md bg-subtle text-ink-secondary items-center justify-center" aria-hidden>
                            <Building2 className="w-3.5 h-3.5" />
                          </span>
                          <span className={`font-semibold ${d.isActive ? 'text-ink' : 'text-ink-muted'}`}>{d.name}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <CodeChip>{d.code}</CodeChip>
                      </td>
                      <td data-empty={d.itemCodePrefixes?.length ? undefined : ''}>
                        {d.itemCodePrefixes?.length ? (
                          <div className="flex flex-wrap gap-1">
                            {d.itemCodePrefixes.map((p) => (
                              <CodeChip key={p} tone="accent">
                                {p}
                              </CodeChip>
                            ))}
                          </div>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        <StatusBadge status={d.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" />
                      </td>
                      {canEdit && (
                        <td className="text-right whitespace-nowrap" data-label="">
                          <div className="inline-flex items-center gap-0.5">
                            <IconButton label={`Edit ${d.name}`} onClick={() => openEdit(d)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </IconButton>
                            <IconButton label={`Delete ${d.name}`} tone="danger" onClick={() => setDeleting(d)}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </IconButton>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
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
          <Toggle
            checked={form.isActive}
            onChange={(isActive) => setForm({ ...form, isActive })}
            label="Active"
            description="Inactive departments are hidden from selection lists, and jobs whose Item Code maps to them cannot be planned or started."
          />
        </form>
      </Modal>

      <ConfirmModal
        isOpen={deleting !== null}
        title="Delete department"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <span className="font-semibold text-ink">{deleting?.name}</span>? If machines, check types, users or Item Code mappings
            still belong to it, it will be marked inactive instead.
          </>
        }
        onConfirm={remove}
        onClose={() => setDeleting(null)}
      />
    </div>
  )
}
