import React, { useState } from 'react'
import type { Department } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { Badge, DataState, FormError, FormSection, Input, List, PrimaryButton, Row, Screen, ToggleField, confirm, useToast } from '../ui'
import { ActionGroup, ActionItem } from './adminParts'

/** Departments: plant departments used to group machines, check types and workers. */
export const DepartmentsScreen: React.FC<{ params: Record<string, unknown> }> = () => {
  const { can, push } = useStaff()
  const canEdit = can('departments', 'manage')
  const { data, error, loading, reload } = useQuery<Department[]>('/api/departments')
  const departments = data ?? []

  return (
    <Screen
      title="Departments"
      onRefresh={reload}
      refreshing={loading && !!data}
      right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push('departmentForm', {}) } : null}
    >
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && departments.length === 0}
        emptyText="No departments yet"
        emptyIcon="business-outline"
      >
        <List>
          {departments.map((d) => (
            <Row
              key={d.id}
              title={d.name}
              titleClassName={d.isActive ? '' : 'text-staff-muted'}
              subtitle={d.code}
              right={d.isActive ? undefined : <Badge label="Inactive" tone="neutral" />}
              onPress={canEdit ? () => push('departmentForm', { department: d }) : undefined}
              accessibilityLabel={canEdit ? `Edit ${d.name}` : undefined}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

/** Add or edit a department; editing also offers Delete (in-use departments are disabled instead). */
export const DepartmentFormScreen: React.FC<{ params: { department?: Department } }> = ({ params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('departments', 'manage')
  const editing = params.department ?? null
  const [name, setName] = useState(editing?.name ?? '')
  const [code, setCode] = useState(editing?.code ?? '')
  const [isActive, setIsActive] = useState(editing?.isActive ?? true)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const submit = async () => {
    if (!name.trim() || !code.trim()) {
      setFormError('Name and code are required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const body = { name: name.trim(), code: code.trim(), isActive }
      if (!editing) {
        await api.post('/api/departments', body)
        notify('success', 'Department created', body.name)
      } else {
        await api.put(`/api/departments/${editing.id}`, body)
        notify('success', 'Department updated', body.name)
      }
      pop()
    } catch (err) {
      setFormError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!editing) return
    const ok = await confirm(
      'Delete department',
      `Delete ${editing.name}? If machines, check types or users still belong to it, it will be marked inactive instead.`,
      'Delete',
      true
    )
    if (!ok) return
    setDeleting(true)
    try {
      const { result } = await api.del(`/api/departments/${editing.id}`)
      if (result === 'disabled') {
        notify('warning', 'Department disabled', `${editing.name} is in use, so it was marked inactive instead of deleted.`)
      } else {
        notify('success', 'Department deleted', editing.name)
      }
      pop()
    } catch (err) {
      notify('error', 'Could not delete department', errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Screen
      title={editing ? 'Edit Department' : 'Add Department'}
      subtitle={editing?.name}
      footer={canEdit ? <PrimaryButton label={editing ? 'Save changes' : 'Create department'} onPress={submit} loading={saving} disabled={deleting} /> : undefined}
    >
      <FormError message={formError} />
      <FormSection title="Details">
        <Input label="Name" required value={name} onChangeText={setName} placeholder="e.g. Printing" maxLength={100} />
        <Input label="Code" required value={code} onChangeText={setCode} placeholder="e.g. PRT" maxLength={30} autoCapitalize="characters" />
      </FormSection>
      <FormSection title="Status">
        <ToggleField label="Active" description="Inactive departments are hidden from selection lists." value={isActive} onChange={setIsActive} disabled={!canEdit} />
      </FormSection>
      {canEdit && editing ? (
        <ActionGroup>
          <ActionItem
            label={deleting ? 'Deleting…' : 'Delete department'}
            accessibilityLabel="Delete department"
            description="Departments still in use are marked inactive instead."
            tone="danger"
            onPress={remove}
            disabled={deleting || saving}
          />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

export const DEPARTMENTS_SCREENS = {
  departments: DepartmentsScreen,
  departmentForm: DepartmentFormScreen
}
