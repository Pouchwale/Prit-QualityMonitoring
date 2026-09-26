import React, { useMemo, useState } from 'react'
import { Text } from 'react-native'
import type { MonitoringReason } from '../types'
import { api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { ActionGroup, ActionItem, facts } from './adminParts'
import {
  AccessDenied,
  Badge,
  DataState,
  FormError,
  FormSection,
  Input,
  List,
  PrimaryButton,
  Row,
  Screen,
  ToggleField,
  confirm,
  useToast
} from '../ui'

/**
 * The lists of reasons a worker may pick, both opened from Check Types, exactly as in the web
 * panel: **N/A reasons** for a single parameter (/api/monitoring-reasons) and **Exception
 * reasons** for a whole check (/api/exception-reasons). Two separate lists with the same fields,
 * so one screen serves both.
 *
 * Reading needs view on Check Types, Quality Checks or Exceptions; changing needs Check Types
 * manage, and the backend enforces it. Deactivating never deletes: a check that already used a
 * reason keeps its text.
 */

interface ReasonKindConfig {
  title: string
  /** Sentence under the title. */
  intro: string
  endpoint: string
  /** Route of the add / edit screen of this list. */
  formRoute: string
  /** Screen title of the form, e.g. "N/A reason". */
  noun: string
  formSubtitle: string
  placeholder: string
  emptyText: string
}

const NA: ReasonKindConfig = {
  title: 'N/A reasons',
  intro: 'Workers pick one of these when a parameter cannot be measured. A not-applicable reading never counts as outside limits.',
  endpoint: '/api/monitoring-reasons',
  formRoute: 'naReasonForm',
  noun: 'N/A reason',
  formSubtitle: 'Shown to workers when a parameter cannot be measured',
  placeholder: 'e.g. No production',
  emptyText: 'No N/A reasons yet. Add the first one.'
}

const EXCEPTION: ReasonKindConfig = {
  title: 'Exception reasons',
  intro: 'Workers pick one of these when a whole check cannot be done. The check is then recorded as an Exception for review.',
  endpoint: '/api/exception-reasons',
  formRoute: 'exceptionReasonForm',
  noun: 'Exception reason',
  formSubtitle: 'Shown to workers when a check cannot be done at all',
  placeholder: 'e.g. Power cut',
  emptyText: 'No exception reasons yet. Add the first one.'
}

const ReasonsScreen: React.FC<{ config: ReasonKindConfig }> = ({ config }) => {
  const { can, push } = useStaff()
  const canView = can('activities') || can('checks') || can('exceptions')
  const canEdit = can('activities', 'manage')
  const { data, error, loading, reload } = useQuery<MonitoringReason[]>(canView ? config.endpoint : null)
  const reasons = useMemo(() => [...(data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label)), [data])
  const active = reasons.filter((r) => r.isActive).length

  if (!canView) {
    return (
      <Screen title={config.title}>
        <AccessDenied title={`You do not have permission to see the ${config.title.toLowerCase()}.`} />
      </Screen>
    )
  }

  return (
    <Screen
      title={config.title}
      onRefresh={reload}
      refreshing={loading && !!data}
      right={canEdit ? { label: 'Add', icon: 'add', onPress: () => push(config.formRoute, {}) } : null}
    >
      <Text className="px-1 text-[13px] leading-[18px] text-staff-muted">
        {data ? `${active} active of ${reasons.length}. ` : ''}
        {config.intro}
      </Text>
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && reasons.length === 0}
        emptyText={config.emptyText}
        emptyIcon="close-circle-outline"
      >
        <List>
          {reasons.map((r) => (
            <Row
              key={r.id}
              title={r.label}
              titleClassName={r.isActive ? '' : 'text-staff-muted'}
              subtitle={facts(r.requiresRemark ? 'Worker must write a remark' : 'Remark optional', `Order ${r.sortOrder}`)}
              right={r.isActive ? undefined : <Badge label="Inactive" tone="neutral" />}
              onPress={canEdit ? () => push(config.formRoute, { reason: r }) : undefined}
              accessibilityLabel={canEdit ? `Edit ${r.label}` : undefined}
            />
          ))}
        </List>
      </DataState>
    </Screen>
  )
}

interface ReasonForm {
  label: string
  requiresRemark: boolean
  isActive: boolean
  sortOrder: string
}

const ReasonFormScreen: React.FC<{ config: ReasonKindConfig; params: { reason?: MonitoringReason } }> = ({ config, params }) => {
  const { can, pop } = useStaff()
  const notify = useToast()
  const canEdit = can('activities', 'manage')
  const editing = params.reason ?? null
  const [form, setForm] = useState<ReasonForm>(() =>
    editing
      ? { label: editing.label, requiresRemark: editing.requiresRemark, isActive: editing.isActive, sortOrder: String(editing.sortOrder) }
      : { label: '', requiresRemark: false, isActive: true, sortOrder: '0' }
  )
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const set = <K extends keyof ReasonForm>(key: K, value: ReasonForm[K]) => setForm((f) => ({ ...f, [key]: value }))
  const title = editing ? `Edit ${config.noun}` : `Add ${config.noun}`

  if (!canEdit) {
    return (
      <Screen title={title}>
        <AccessDenied title={`You do not have permission to change the ${config.title.toLowerCase()}.`} message="It needs manage access to Check Types." />
      </Screen>
    )
  }

  const submit = async () => {
    const label = form.label.trim()
    const sortOrder = Number(form.sortOrder || '0')
    if (!label) return setFormError('Enter the reason shown to workers')
    if (!Number.isInteger(sortOrder) || sortOrder < 0) return setFormError('Order must be a whole number, 0 or more')
    setSaving(true)
    setFormError(null)
    try {
      const body = { label, requiresRemark: form.requiresRemark, isActive: form.isActive, sortOrder }
      if (editing) {
        await api.put(`${config.endpoint}/${editing.id}`, body)
        notify('success', `${config.noun} updated`, label)
      } else {
        await api.post(config.endpoint, body)
        notify('success', `${config.noun} added`, label)
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
      `Deactivate ${config.noun.toLowerCase()}?`,
      `${editing.label} will no longer be offered to workers. Checks that already used it keep the reason, so history stays complete.`,
      'Deactivate',
      true
    )
    if (!ok) return
    setDeleting(true)
    try {
      await api.del(`${config.endpoint}/${editing.id}`)
      notify('success', `${config.noun} deactivated`, editing.label)
      pop()
    } catch (err) {
      notify('error', 'Could not deactivate the reason', errorText(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Screen
      title={title}
      subtitle={editing?.label ?? config.formSubtitle}
      footer={<PrimaryButton label={editing ? 'Save changes' : 'Add reason'} onPress={submit} loading={saving} disabled={deleting} />}
    >
      <FormError message={formError} />
      <FormSection title="Details">
        <Input label="Reason" required value={form.label} onChangeText={(v) => set('label', v)} placeholder={config.placeholder} maxLength={120} />
        <Input
          label="Order"
          hint="Lower numbers appear first in the worker's list."
          value={form.sortOrder}
          onChangeText={(v) => set('sortOrder', v.replace(/\D/g, ''))}
          keyboardType="number-pad"
          maxLength={3}
        />
        <ToggleField
          label="Requires remark"
          description="The worker must also write what happened, e.g. for “Other”."
          value={form.requiresRemark}
          onChange={(v) => set('requiresRemark', v)}
        />
        <ToggleField label="Active" description="Inactive reasons are not offered to workers." value={form.isActive} onChange={(v) => set('isActive', v)} />
      </FormSection>

      {editing ? (
        <ActionGroup>
          <ActionItem
            label={deleting ? 'Deactivating…' : 'Deactivate reason'}
            accessibilityLabel="Deactivate reason"
            description="Kept on old submissions; workers no longer see it."
            tone="danger"
            onPress={remove}
            disabled={deleting || saving}
          />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

export const REASONS_SCREENS = {
  naReasons: () => <ReasonsScreen config={NA} />,
  naReasonForm: ({ params }: { params: { reason?: MonitoringReason } }) => <ReasonFormScreen config={NA} params={params} />,
  exceptionReasons: () => <ReasonsScreen config={EXCEPTION} />,
  exceptionReasonForm: ({ params }: { params: { reason?: MonitoringReason } }) => <ReasonFormScreen config={EXCEPTION} params={params} />
}
