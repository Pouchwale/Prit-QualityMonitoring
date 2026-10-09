import React, { useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, Info, Pencil, Plus, Power, Tags, Trash2 } from 'lucide-react'
import type { Department, DepartmentMapping } from '../../types'
import { api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { formatDateTime } from '../../lib/format'
import { Button } from '../../components/common/Button'
import { ConfirmModal } from '../../components/common/ConfirmModal'
import { DataState } from '../../components/common/DataState'
import { Field, FormError, Select, TextInput, Toggle } from '../../components/common/Form'
import { Modal } from '../../components/common/Modal'
import { PageHeader } from '../../components/common/PageHeader'
import { StatusBadge } from '../../components/common/StatusBadge'
import { useToast } from '../../components/common/Toast'
import { Card, EmptyState } from '../../components/ui/Card'
import { IconButton, ResultCount, SearchInput, Segmented, Toolbar, ToolbarSpacer } from '../../components/ui/Toolbar'
import { CodeChip, matchesStatus, type StatusTab } from '../../components/ui/Chips'

interface FormState {
  prefix: string
  departmentId: string
  isActive: boolean
}

const emptyForm: FormState = { prefix: '', departmentId: '', isActive: true }

type Pending = { kind: 'deactivate' | 'delete'; mapping: DepartmentMapping }

/**
 * Department Configuration: which department each Item Code prefix stands for (RMLA -> Label). The
 * server reads it whenever a job is planned or started; saved jobs and checks keep their department.
 * Anyone who may view Departments sees it; changing it needs Departments manage (checked again by
 * the server).
 */
export const DepartmentConfigPage: React.FC = () => {
  const canEdit = useCanManage('departments')
  const notify = useToast()
  const { data, error, loading, reload } = useApi<DepartmentMapping[]>('/api/department-mappings')
  const departmentsApi = useApi<Department[]>(canEdit ? '/api/departments' : null)

  const [editing, setEditing] = useState<DepartmentMapping | 'new' | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)

  const mappings = useMemo(() => data ?? [], [data])
  const [search, setSearch] = useState('')
  const [statusTab, setStatusTab] = useState<StatusTab>('ALL')
  const activeCount = mappings.filter((m) => m.isActive).length
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return mappings.filter((m) => matchesStatus(statusTab, m.isActive) && (!q || [m.prefix, m.departmentName, m.departmentCode].some((v) => v?.toLowerCase().includes(q))))
  }, [mappings, search, statusTab])
  // Inactive departments are offered only when the mapping already uses one.
  const departmentOptions = (departmentsApi.data ?? []).filter((d) => d.isActive || (editing !== 'new' && editing?.departmentId === d.id))

  const openNew = () => {
    setForm(emptyForm)
    setFormError(null)
    setEditing('new')
  }

  const openEdit = (m: DepartmentMapping) => {
    setForm({ prefix: m.prefix, departmentId: m.departmentId, isActive: m.isActive })
    setFormError(null)
    setEditing(m)
  }

  const close = () => setEditing(null)

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    const prefix = form.prefix.trim().toUpperCase()
    if (!prefix || !form.departmentId) {
      setFormError('Enter the Item Code prefix and choose a department')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      if (editing === 'new') {
        await api.post('/api/department-mappings', { prefix, departmentId: form.departmentId, isActive: form.isActive })
        notify('success', 'Mapping added', prefix)
      } else if (editing) {
        await api.patch(`/api/department-mappings/${editing.id}`, { prefix, departmentId: form.departmentId })
        notify('success', 'Mapping updated', prefix)
      }
      setEditing(null)
      reload()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const setStatus = async (m: DepartmentMapping, isActive: boolean) => {
    try {
      await api.patch(`/api/department-mappings/${m.id}/status`, { isActive })
      notify('success', isActive ? 'Mapping activated' : 'Mapping deactivated', `${m.prefix} → ${m.departmentName}`)
      reload()
    } catch (err) {
      notify('error', isActive ? 'Could not activate mapping' : 'Could not deactivate mapping', errorText(err))
    }
  }

  const remove = async (m: DepartmentMapping) => {
    try {
      await api.del(`/api/department-mappings/${m.id}`)
      notify('success', 'Mapping deleted', m.prefix)
      reload()
    } catch (err) {
      notify('error', 'Could not delete mapping', errorText(err))
    }
  }

  const confirmPending = async () => {
    if (!pending) return
    if (pending.kind === 'deactivate') await setStatus(pending.mapping, false)
    else await remove(pending.mapping)
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Tags className="w-4.5 h-4.5" />}
        title="Department Configuration"
        description={data ? `${mappings.length} Item Code ${mappings.length === 1 ? 'prefix' : 'prefixes'} · ${activeCount} active` : 'Item Code prefix → department'}
        info="Which department each Item Code prefix stands for. When a job is planned or started, its department is worked out from here (e.g. RMLA12345 → the RMLA mapping). Jobs and checks already saved keep their department."
        actions={
          canEdit && (
            <Button size="sm" variant="primary" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
              Add Mapping
            </Button>
          )
        }
      />

      <DataState loading={loading} error={error} onRetry={reload} empty={data ? false : undefined}>
        <Card className="overflow-hidden">
          <Toolbar>
            <SearchInput value={search} onChange={setSearch} label="Search mappings" placeholder="Prefix or department…" />
            <Segmented<StatusTab>
              label="Filter by status"
              value={statusTab}
              onChange={setStatusTab}
              options={[
                { value: 'ALL', label: 'All', count: mappings.length },
                { value: 'ACTIVE', label: 'Active', count: activeCount },
                { value: 'INACTIVE', label: 'Inactive', count: mappings.length - activeCount }
              ]}
            />
            <ToolbarSpacer />
            <ResultCount shown={filtered.length} total={mappings.length} noun={mappings.length === 1 ? 'mapping' : 'mappings'} />
          </Toolbar>

          {filtered.length === 0 ? (
            <EmptyState
              icon={<Tags className="w-5 h-5" />}
              title={mappings.length === 0 ? 'No Item Code mappings yet' : 'No mappings match the filters'}
              action={
                mappings.length === 0 && canEdit ? (
                  <Button size="sm" variant="outline" onClick={openNew} icon={<Plus className="w-3.5 h-3.5" />}>
                    Add Mapping
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table stack-sm">
                <thead>
                  <tr>
                    <th>Item Code prefix</th>
                    <th>Department</th>
                    <th>Example</th>
                    <th>Status</th>
                    <th className="num">Jobs</th>
                    <th>Last changed</th>
                    {canEdit && (
                      <th className="text-right">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <tr key={m.id}>
                      <td className="whitespace-nowrap">
                        <CodeChip tone={m.isActive ? 'accent' : 'neutral'} className="!text-[12.5px] !h-6 !px-2 font-semibold">
                          {m.prefix}
                        </CodeChip>
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <span className="font-medium text-ink">{m.departmentName}</span>
                          {!m.departmentActive && (
                            <span className="inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-exception-bg text-exception ring-1 ring-inset ring-exception-line text-[11px] font-medium">
                              <AlertTriangle className="w-3 h-3" aria-hidden />
                              Department inactive
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ink-muted">
                          {m.prefix}12345
                          <ArrowRight className="w-3 h-3 text-ink-faint" aria-label="maps to" />
                          <span className="font-sans text-ink-secondary">{m.departmentName}</span>
                        </span>
                      </td>
                      <td className="whitespace-nowrap">
                        <StatusBadge status={m.isActive ? 'ACTIVE' : 'INACTIVE'} size="sm" />
                      </td>
                      <td className={`num ${m.jobCount > 0 ? 'text-ink font-medium' : 'text-ink-faint'}`}>{m.jobCount}</td>
                      <td className="whitespace-nowrap">
                        <div className="text-ink-secondary tabular-nums">{formatDateTime(m.updatedAt)}</div>
                        {m.updatedByName && <div className="text-[11.5px] text-ink-muted">{m.updatedByName}</div>}
                      </td>
                      {canEdit && (
                        <td className="text-right whitespace-nowrap" data-label="">
                          <div className="inline-flex items-center gap-0.5">
                            <IconButton label={`Edit ${m.prefix}`} onClick={() => openEdit(m)}>
                              <Pencil className="w-3.5 h-3.5" />
                            </IconButton>
                            <IconButton
                              label={`${m.isActive ? 'Deactivate' : 'Activate'} ${m.prefix}`}
                              tone={m.isActive ? 'danger' : 'neutral'}
                              onClick={() => (m.isActive ? setPending({ kind: 'deactivate', mapping: m }) : setStatus(m, true))}
                            >
                              <Power className={`w-3.5 h-3.5 ${m.isActive ? '' : 'text-success'}`} />
                            </IconButton>
                            <IconButton
                              label={m.jobCount > 0 ? `Delete ${m.prefix}: used by ${m.jobCount} ${m.jobCount === 1 ? 'job' : 'jobs'}, deactivate it instead` : `Delete ${m.prefix}`}
                              tone="danger"
                              onClick={() => setPending({ kind: 'delete', mapping: m })}
                              disabled={m.jobCount > 0}
                            >
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

          <div className="flex items-start gap-2 px-4 py-3 border-t border-line bg-subtle/60 text-[12px] text-ink-muted">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-faint" aria-hidden />
            <p>
              Matching ignores upper and lower case. Prefixes cannot overlap (RM and RMLA cannot both exist), so an Item Code matches at most one
              mapping. An Item Code with no mapping, an inactive mapping or an inactive department cannot start a job. A new department also needs
              its check types and parameters set up before its jobs can start.
            </p>
          </div>
        </Card>
      </DataState>

      <Modal
        isOpen={editing !== null}
        onClose={close}
        title={editing === 'new' ? 'Add Mapping' : 'Edit Mapping'}
        subtitle={editing !== 'new' && editing && editing.jobCount > 0 ? `Jobs already saved keep the department they were given.` : undefined}
        maxWidth="sm"
        footer={
          <>
            <Button size="sm" variant="outline" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" type="submit" form="mapping-form" loading={saving}>
              {editing === 'new' ? 'Add Mapping' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <form id="mapping-form" onSubmit={submit} className="space-y-3">
          <FormError message={formError} />
          <Field label="Item Code prefix" required hint="How the Item Codes start, e.g. RMLA. 2 to 20 letters or digits; hyphens allowed after the first.">
            {/* Shown in capitals, sent in capitals: changing the text itself would move the cursor. */}
            <TextInput
              value={form.prefix}
              onChange={(e) => setForm({ ...form, prefix: e.target.value })}
              placeholder="e.g. RMLA"
              maxLength={20}
              className="font-mono uppercase"
              autoFocus
            />
          </Field>
          <Field label="Department" required hint="A new department is added on the Departments page first.">
            <Select value={form.departmentId} onChange={(e) => setForm({ ...form, departmentId: e.target.value })} disabled={departmentsApi.loading && !departmentsApi.data}>
              <option value="">Choose a department</option>
              {departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </Select>
          </Field>
          {departmentsApi.error && <FormError message={`Could not load departments: ${departmentsApi.error}`} />}
          {editing === 'new' && (
            <Toggle
              checked={form.isActive}
              onChange={(isActive) => setForm({ ...form, isActive })}
              label="Active"
              description="Only active mappings let jobs start. You can switch it later."
            />
          )}
        </form>
      </Modal>

      <ConfirmModal
        isOpen={pending !== null}
        title={pending?.kind === 'delete' ? 'Delete mapping' : 'Deactivate mapping'}
        danger
        confirmLabel={pending?.kind === 'delete' ? 'Delete' : 'Deactivate'}
        message={
          pending?.kind === 'delete' ? (
            <>
              Delete <span className="font-mono font-semibold text-ink">{pending.mapping.prefix}</span> → {pending.mapping.departmentName}? Item
              Codes starting with {pending.mapping.prefix} will no longer find a department.
            </>
          ) : (
            <>
              Deactivate <span className="font-mono font-semibold text-ink">{pending?.mapping.prefix}</span> → {pending?.mapping.departmentName}?
              Jobs with Item Codes starting {pending?.mapping.prefix} cannot be planned or started until it is activated again. Jobs already
              running and past records keep their department.
            </>
          )
        }
        onConfirm={confirmPending}
        onClose={() => setPending(null)}
      />
    </div>
  )
}
