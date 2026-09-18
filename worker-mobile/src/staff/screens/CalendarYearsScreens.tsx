import React, { useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Image, Platform, Pressable, Text, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import type { CalendarIssue, CalendarYearDetail, CalendarYearItem, CalendarYearSummary, ClosureType } from '../types'
import { API_URL, ApiError, api, authHeaders, readError, uploadFile, withQuery } from '../../services/api'
import { downloadAndShare } from '../../services/files'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { CLOSURE_META, WEEKDAY_NAMES, formatDateTime, keyToDate, type Tone } from '../format'
import {
  Badge,
  Card,
  Chips,
  DataState,
  DateField,
  FieldLabel,
  FormError,
  FormSection,
  Icon,
  Input,
  List,
  MiniStat,
  Notice,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  SelectField,
  SmallButton,
  confirm,
  useToast
} from '../ui'
import { ICON_COLOR } from '../Icon'
import { ActionGroup, ActionItem, StatusText } from './adminParts'

// Same wording and rules as admin-web/src/pages/admin/calendar/AnnualCalendarsTab.tsx.

const fullDate = (iso: string) => keyToDate(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const weekdayName = (iso: string) => WEEKDAY_NAMES[keyToDate(iso).getDay()]
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const METHOD_LABEL: Record<string, string> = {
  EXCEL: 'Excel / CSV',
  PDF_TEXT: 'PDF text',
  OCR: 'Offline OCR',
  MANUAL: 'Entered by hand'
}

const ITEM_TYPES: ClosureType[] = ['HOLIDAY', 'WORKING', 'SHUTDOWN', 'CLOSED']

/** The web panel's type labels and hints (format.ts shortens some of them). */
const TYPE_INFO: Record<ClosureType, { label: string; hint: string }> = {
  CLOSED: { label: 'Plant Closed', hint: 'Weekly off or unplanned closure' },
  HOLIDAY: { label: 'Holiday', hint: 'Festival or public holiday' },
  SHUTDOWN: { label: 'Shutdown', hint: 'Maintenance or production shutdown' },
  WORKING: { label: 'Adjustment Working Day', hint: 'Plant runs normally: checks and alerts as scheduled' }
}

/** Accepted by the backend (services/calendarYears.ts ACCEPTED_DOCUMENTS). */
const ACCEPTED_DOCUMENTS = /\.(xlsx|csv|pdf|png|jpe?g|webp|bmp)$/i
const DOCUMENT_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/comma-separated-values',
  'application/vnd.ms-excel',
  'text/plain',
  'image/*'
]

/** Approved and unchanged is the normal state; lists show a status only for the others. */
const inUse = (year: { status: string; pendingChanges: boolean }) => year.status === 'APPROVED' && !year.pendingChanges

function yearStatus(year: { status: string; pendingChanges: boolean }): { label: string; tone: Tone } {
  if (year.status === 'APPROVED' && year.pendingChanges) return { label: 'Changes awaiting approval', tone: 'exception' }
  if (year.status === 'APPROVED') return { label: 'Approved · in use', tone: 'success' }
  return { label: 'Draft · not in use', tone: 'neutral' }
}

type ImportResult = CalendarYearDetail & { summary: { method: string; datesFound: number; uncertain: number } }

// ---------------------------------------------------------------- list

/** Annual calendars: one company calendar per year; open a year to import, review and approve it. */
export const CalendarYearsScreen: React.FC<{ params?: Record<string, never> }> = () => {
  const { can, push } = useStaff()
  const canEdit = can('calendar', 'manage')
  const { data, error, loading, reload } = useQuery<{ firstYear: number; years: CalendarYearSummary[] }>('/api/calendar-years')
  const years = data?.years ?? []
  const choices = useYearChoices(data)

  return (
    <Screen
      title="Annual calendars"
      subtitle="Plant Calendar"
      right={canEdit ? { label: 'New', icon: 'add', onPress: () => push('calendarYearNew'), disabled: !data || choices.length === 0 } : null}
      onRefresh={reload}
      refreshing={loading && !!data}
    >
      <Notice
        tone="accent"
        message={`One company calendar per year from ${data?.firstYear ?? 2027}. Import the company document, check every date, then approve. Dates only affect checks and alerts after approval.`}
      />
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && years.length === 0}
        emptyText="No annual calendars yet. Create the next year's calendar when the company holiday list is available."
        emptyIcon="calendar-number-outline"
      >
        <List>
          {years.map((year) => {
            const status = yearStatus(year)
            const state = year.openIssues
              ? `${plural(year.openIssues, 'item')} to check`
              : year.holidays + year.workingDays === 0
                ? 'No dates yet'
                : year.approvedAt && !year.pendingChanges
                  ? `Approved ${formatDateTime(year.approvedAt)}`
                  : 'Ready to approve'
            return (
              <Row
                key={year.id}
                title={String(year.year)}
                subtitle={`${plural(year.holidays, 'holiday')} · ${plural(year.workingDays, 'adjustment working day')}`}
                detail={year.sourceFileName ? state : `No document imported · ${state}`}
                detailLines={1}
                right={inUse(year) ? undefined : <Badge label={status.label.split(' · ')[0]} tone={status.tone} />}
                accessibilityLabel={`${year.year} calendar, ${status.label}`}
                onPress={() => push('calendarYearDetail', { id: year.id })}
              />
            )
          })}
        </List>
      </DataState>
    </Screen>
  )
}

function useYearChoices(data: { firstYear: number; years: CalendarYearSummary[] } | null) {
  return useMemo(() => {
    if (!data) return []
    const existing = new Set(data.years.map((y) => y.year))
    const last = new Date().getFullYear() + 10
    return Array.from({ length: Math.max(last - data.firstYear + 1, 0) }, (_, i) => data.firstYear + i).filter((y) => !existing.has(y))
  }, [data])
}

/** New calendar year (manage only). */
export const CalendarYearNewScreen: React.FC<{ params?: Record<string, never> }> = () => {
  const { replace } = useStaff()
  const notify = useToast()
  const { data, error, loading, reload } = useQuery<{ firstYear: number; years: CalendarYearSummary[] }>('/api/calendar-years')
  const choices = useYearChoices(data)
  const [picked, setPicked] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const year = picked || (choices[0] ? String(choices[0]) : '')

  const create = async () => {
    if (!year) return
    setSaving(true)
    setFormError(null)
    try {
      const detail = await api.post<CalendarYearDetail>('/api/calendar-years', { year: Number(year) })
      notify('success', `${year} calendar created`, 'Import the company document or add the dates by hand, then approve.')
      replace('calendarYearDetail', { id: detail.year.id })
    } catch (err) {
      setFormError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <Screen
      title="New calendar year"
      subtitle="Weekly rules apply at once; holidays apply after approval"
      footer={<PrimaryButton label="Create calendar" onPress={create} loading={saving} disabled={!year} />}
    >
      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && choices.length === 0}
        emptyText="Every available year already has a calendar."
        emptyIcon="calendar-number-outline"
      >
        <FormError message={formError} />
        <FormSection title="Year" description="Create one calendar per year, then import the company document.">
          <SelectField label="Year" required value={year} options={choices.map((y) => ({ value: String(y), label: String(y) }))} onChange={(v) => v && setPicked(v)} />
        </FormSection>
      </DataState>
    </Screen>
  )
}

// ---------------------------------------------------------------- review

/** One calendar year: the company document, every date with its review state, import, approve. */
export const CalendarYearDetailScreen: React.FC<{ params: { id: string } }> = ({ params }) => {
  const { can, push, pop } = useStaff()
  const canEdit = can('calendar', 'manage')
  const notify = useToast()
  const { data, error, loading, reload, setData } = useQuery<CalendarYearDetail>(`/api/calendar-years/${params.id}`)
  const [progress, setProgress] = useState<number | null>(null)
  const [approving, setApproving] = useState(false)
  const [busyItem, setBusyItem] = useState<string | null>(null)
  const [filter, setFilter] = useState<'' | 'review'>('')
  const [search, setSearch] = useState('')
  const [docVersion, setDocVersion] = useState(0)

  const issuesByItem = useMemo(() => {
    const map = new Map<string, CalendarIssue[]>()
    for (const issue of data?.issues ?? []) if (issue.itemId) map.set(issue.itemId, [...(map.get(issue.itemId) ?? []), issue])
    return map
  }, [data])

  if (!data) {
    return (
      <Screen title="Annual calendar" onRefresh={reload} refreshing={false}>
        <DataState loading={loading} error={error} onRetry={reload}>
          {null}
        </DataState>
      </Screen>
    )
  }

  const { year, items, issues } = data
  const yearId = params.id
  const status = yearStatus(year)
  const holidays = items.filter((i) => i.type !== 'WORKING')
  const workingDays = items.filter((i) => i.type === 'WORKING')
  const blocking = issues.filter((i) => i.severity === 'BLOCKING')
  const checks = issues.filter((i) => i.severity === 'CHECK')
  const generalIssues = issues.filter((i) => !i.itemId && i.severity !== 'INFO')
  const sorted = [...items].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.position - b.position)
  const needsReview = (item: CalendarYearItem) => (issuesByItem.get(item.id) ?? []).some((i) => i.severity !== 'INFO')
  const reviewCount = items.filter(needsReview).length
  const term = search.trim().toLowerCase()
  const shown = sorted.filter(
    (item) =>
      (!filter || needsReview(item)) &&
      (!term ||
        `${item.date ?? ''} ${item.date ? `${fullDate(item.date)} ${weekdayName(item.date)}` : ''} ${item.name ?? ''} ${TYPE_INFO[item.type].label} ${item.sourceText ?? ''}`
          .toLowerCase()
          .includes(term))
  )
  const importing = progress !== null
  const ready = !blocking.length && !checks.length && items.length > 0

  const approveHint = !canEdit
    ? null
    : blocking.length || checks.length
      ? `${plural(blocking.length + checks.length, 'item')} to fix or check first`
      : items.length === 0
        ? 'Add the dates first'
        : year.status === 'APPROVED' && !year.pendingChanges
          ? 'Approved and in use'
          : null

  const runImport = async (file: DocumentPicker.DocumentPickerAsset, replace: boolean) => {
    setProgress(0)
    try {
      const result = await uploadFile<ImportResult>(
        withQuery(`/api/calendar-years/${yearId}/import`, { replace: String(replace) }),
        'document',
        { uri: file.uri, name: file.name, mimeType: file.mimeType, file: file.file ?? null },
        setProgress
      )
      const { summary, ...detail } = result
      setData(detail)
      setDocVersion((v) => v + 1)
      notify(
        summary.datesFound ? 'success' : 'warning',
        summary.datesFound ? `${summary.datesFound} dates read from ${file.name}` : 'No dates could be read',
        summary.datesFound
          ? `${summary.uncertain ? `${summary.uncertain} need checking. ` : ''}Check every date against the document before approving.`
          : 'Add the dates by hand, or upload a clearer copy of the calendar.'
      )
    } catch (err) {
      notify('error', 'Could not import the document', errorText(err))
    } finally {
      setProgress(null)
    }
  }

  const chooseFile = async () => {
    let result: DocumentPicker.DocumentPickerResult
    try {
      result = await DocumentPicker.getDocumentAsync({ type: DOCUMENT_TYPES, copyToCacheDirectory: true, multiple: false, base64: false })
    } catch (err) {
      notify('error', 'Could not open the file picker', errorText(err))
      return
    }
    const file = result.canceled ? null : result.assets[0]
    if (!file) return
    if (!ACCEPTED_DOCUMENTS.test(file.name)) {
      notify('error', 'Could not import the document', 'Upload the calendar as an Excel file (.xlsx), CSV, PDF or image (JPG/PNG).')
      return
    }
    if (items.length) {
      const ok = await confirm(
        'Replace the dates?',
        `Importing ${file.name} replaces the ${items.length} dates in this calendar, including any you have edited or checked. ${year.status === 'APPROVED' ? 'The approved dates stay in use until you approve again.' : ''}`.trim(),
        'Import and replace',
        true
      )
      if (!ok) return
      await runImport(file, true)
    } else {
      await runImport(file, false)
    }
  }

  const act = async (itemId: string, fn: () => Promise<CalendarYearDetail>, success: string) => {
    setBusyItem(itemId)
    try {
      setData(await fn())
      notify('success', success)
    } catch (err) {
      notify('error', 'Could not save', errorText(err))
    } finally {
      setBusyItem(null)
    }
  }

  const removeItem = async (item: CalendarYearItem) => {
    const ok = await confirm(
      'Delete this date?',
      `${item.date ? fullDate(item.date) : 'This row'}${item.name ? ` (${item.name})` : ''} is removed from the ${year.year} calendar.`,
      'Delete date',
      true
    )
    if (ok) await act(item.id, () => api.del<CalendarYearDetail>(`/api/calendar-years/${yearId}/items/${item.id}`), 'Date deleted')
  }

  const approve = async () => {
    const ok = await confirm(
      `Approve the ${year.year} calendar?`,
      `From now on these ${holidays.length} holidays and ${workingDays.length} adjustment working days decide scheduling for ${year.year}: no checks, alerts or Missed on holidays, and normal checks with alerts on adjustment working days. Weekly rules apply to every other date.`,
      'Approve'
    )
    if (!ok) return
    setApproving(true)
    try {
      const { removedChecks, ...detail } = await api.post<CalendarYearDetail & { removedChecks: number }>(`/api/calendar-years/${yearId}/approve`)
      setData(detail)
      notify(
        'success',
        `${year.year} calendar approved`,
        `${holidays.length} holidays and ${workingDays.length} adjustment working days now decide checks and alerts.${removedChecks ? ` ${removedChecks} upcoming check${removedChecks === 1 ? ' was' : 's were'} removed from closed days.` : ''}`
      )
    } catch (err) {
      notify('error', 'Could not approve', errorText(err))
    } finally {
      setApproving(false)
    }
  }

  const removeYear = async () => {
    const ok = await confirm(
      `Delete the ${year.year} draft?`,
      'The draft, its dates and the uploaded document are deleted. It has never been approved, so no checks are affected.',
      'Delete draft',
      true
    )
    if (!ok) return
    try {
      await api.del(`/api/calendar-years/${yearId}`)
      notify('success', `${year.year} calendar deleted`)
      pop()
    } catch (err) {
      notify('error', 'Could not delete the calendar', errorText(err))
    }
  }

  const summaryTitle = [
    blocking.length ? `${plural(blocking.length, 'problem')} to fix` : null,
    checks.length ? `${plural(checks.length, 'item')} to check against the document` : null,
    ready ? (year.status === 'APPROVED' && !year.pendingChanges ? 'All dates checked and approved' : 'All dates checked · ready to approve') : null
  ]
    .filter(Boolean)
    .join(' · ')
  const summaryMessage = [
    approveHint && !ready ? 'Approval is available once every row is fixed or checked.' : null,
    year.status === 'APPROVED' && year.pendingChanges ? 'The approved dates stay in use until these changes are approved.' : null
  ]
    .filter(Boolean)
    .join(' ')
  const showApprove = canEdit && (year.status !== 'APPROVED' || year.pendingChanges)
  const percent = Math.round((progress ?? 0) * 100)

  return (
    <Screen
      title={`${year.year} calendar`}
      right={canEdit ? { label: 'Add date', icon: 'add', onPress: () => push('calendarYearItemForm', { yearId }), disabled: importing } : null}
      onRefresh={reload}
      refreshing={loading}
      footer={
        showApprove ? (
          <View className="gap-1.5">
            {approveHint ? <Text className="text-center text-[13px] leading-[18px] text-staff-muted">{approveHint}</Text> : null}
            <PrimaryButton
              label={year.status === 'APPROVED' ? 'Approve changes' : 'Approve calendar'}
              icon="checkmark"
              onPress={approve}
              loading={approving}
              disabled={!!approveHint || importing}
            />
          </View>
        ) : undefined
      }
    >
      <Card className="gap-3 p-4">
        <View className="gap-1">
          <StatusText label={status.label} tone={status.tone} />
          {year.approvedAt ? <Text className="text-[13px] leading-[18px] text-staff-muted">Last approved {formatDateTime(year.approvedAt)}</Text> : null}
        </View>
        <View className="-mx-2 flex-row">
          <MiniStat label="Holidays" value={holidays.length} tone="success" />
          <MiniStat label="Working days" value={workingDays.length} tone="due" accessibilityLabel={`Adjustment working days: ${workingDays.length}`} />
          <MiniStat label="To check" value={reviewCount} tone={blocking.length ? 'missed' : reviewCount ? 'exception' : 'neutral'} />
        </View>
      </Card>

      {summaryTitle || summaryMessage ? (
        <Notice tone={blocking.length ? 'missed' : checks.length ? 'exception' : 'success'} title={summaryTitle || undefined} message={summaryMessage || null} />
      ) : null}
      {year.extractionNote ? <Notice message={year.extractionNote} /> : null}
      {generalIssues.map((issue, i) => (
        <Notice key={i} tone="missed" message={issue.message} />
      ))}

      <Section title="Company document" detail={year.extractionMethod && year.hasDocument ? METHOD_LABEL[year.extractionMethod] : undefined}>
        <View className="gap-2">
          <DocumentCard yearId={yearId} detail={data} version={`${docVersion}-${year.updatedAt}`} />
          {importing ? (
            <Notice
              tone="due"
              icon="cloud-upload-outline"
              title={progress !== null && progress < 1 ? `Uploading the document… ${percent}%` : 'Reading the document…'}
              message="Reading the document on the server. Photos and scans are read with offline OCR, which can take up to a minute."
            >
              <View
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-staff-card"
                accessibilityRole="progressbar"
                accessibilityValue={{ min: 0, max: 100, now: percent }}
              >
                <View className="h-full rounded-full bg-staff-accent" style={{ width: `${percent}%` }} />
              </View>
            </Notice>
          ) : null}
          {canEdit ? (
            <ActionGroup>
              <ActionItem
                icon="cloud-upload-outline"
                label={importing ? 'Reading document…' : year.hasDocument ? 'Import new document' : 'Import document'}
                description="Excel (.xlsx), CSV, PDF or image (JPG/PNG)"
                onPress={chooseFile}
                disabled={importing}
                right={importing ? <ActivityIndicator size="small" color={ICON_COLOR.accent} /> : undefined}
              />
            </ActionGroup>
          ) : null}
        </View>
      </Section>

      <Section title={`Dates (${items.length})`} detail="Check each row against the document">
        {items.length === 0 ? (
          <Notice message={year.hasDocument ? 'No dates were read from the document. Add them by hand.' : 'Import the company calendar document, or add the dates by hand.'} />
        ) : (
          <View className="gap-3">
            <Chips
              value={filter}
              onChange={setFilter}
              options={[
                { value: '', label: 'All', count: items.length },
                { value: 'review', label: 'To check', count: reviewCount }
              ]}
            />
            {items.length > 8 ? <SearchField value={search} onChangeText={setSearch} placeholder="Date, holiday name or document text" accessibilityLabel="Search" /> : null}
            {shown.length === 0 ? (
              <Notice tone={filter ? 'success' : 'neutral'} message={filter ? 'Every row is fixed or checked.' : 'No dates match the search.'} />
            ) : (
              shown.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  holidays={holidays}
                  issues={issuesByItem.get(item.id) ?? []}
                  canEdit={canEdit}
                  busy={busyItem === item.id}
                  onEdit={() => push('calendarYearItemForm', { yearId, itemId: item.id })}
                  onConfirm={() => act(item.id, () => api.post<CalendarYearDetail>(`/api/calendar-years/${yearId}/items/${item.id}/confirm`), 'Row checked')}
                  onDelete={() => removeItem(item)}
                />
              ))
            )}
          </View>
        )}
      </Section>

      {canEdit && year.status === 'DRAFT' ? (
        <ActionGroup>
          <ActionItem label="Delete draft" description="Only drafts that were never approved can be deleted" tone="danger" onPress={removeYear} disabled={importing} />
        </ActionGroup>
      ) : null}
    </Screen>
  )
}

const ItemCard: React.FC<{
  item: CalendarYearItem
  holidays: CalendarYearItem[]
  issues: CalendarIssue[]
  canEdit: boolean
  busy: boolean
  onEdit: () => void
  onConfirm: () => void
  onDelete: () => void
}> = ({ item, holidays, issues, canEdit, busy, onEdit, onConfirm, onDelete }) => {
  const meta = CLOSURE_META[item.type]
  const blocking = issues.filter((i) => i.severity === 'BLOCKING')
  const checks = issues.filter((i) => i.severity === 'CHECK')
  const info = issues.filter((i) => i.severity === 'INFO')
  const dateUncertain = !item.confirmed && item.uncertainFields.includes('date')
  const nameUncertain = !item.confirmed && item.uncertainFields.includes('name')
  const replaces = item.type === 'WORKING' && item.forHolidayDate ? holidays.find((h) => h.date === item.forHolidayDate) : null
  // A thin coloured edge marks rows that still need attention.
  const edge = blocking.length ? 'bg-missed' : checks.length ? 'bg-exception' : ''

  return (
    <Card>
      {edge ? <View className={`absolute bottom-0 left-0 top-0 w-1 ${edge}`} /> : null}
      <View className="gap-2 p-4">
        <View className="flex-row items-start justify-between gap-2">
          <View className="flex-1">
            {item.date ? (
              <Text className={`text-[16px] font-semibold leading-[21px] ${dateUncertain ? 'text-exception' : 'text-staff-ink'}`}>
                {fullDate(item.date)} <Text className="text-[14px] font-normal text-staff-muted">· {weekdayName(item.date)}</Text>
              </Text>
            ) : (
              <Text className="text-[16px] font-semibold leading-[21px] text-missed">Not readable</Text>
            )}
            <Text className={`mt-0.5 text-[15px] leading-[20px] ${nameUncertain ? 'font-medium text-exception' : 'text-staff-ink2'}`}>{item.name || '—'}</Text>
          </View>
          <View className={`flex-row items-center gap-1.5 rounded-full px-2.5 py-0.5 ${meta.bg}`}>
            <View className={`h-2 w-2 rounded-full ${meta.dot}`} />
            <Text className={`text-[12px] font-semibold ${meta.text}`}>{TYPE_INFO[item.type].label}</Text>
          </View>
        </View>

        {blocking.length || checks.length || dateUncertain || nameUncertain ? (
          <View className="flex-row flex-wrap gap-1.5">
            {blocking.length ? (
              <Badge label={plural(blocking.length, 'problem')} tone="missed" />
            ) : checks.length ? (
              <Badge label="To check" tone="exception" />
            ) : null}
            {dateUncertain ? <Badge label="Date uncertain" tone="exception" /> : null}
            {nameUncertain ? <Badge label="Name uncertain" tone="exception" /> : null}
          </View>
        ) : null}

        {item.type === 'WORKING' ? (
          <Text className="text-[13px] leading-[18px] text-staff-muted">
            Replaces {replaces ? `${replaces.name ?? 'holiday'} (${fullDate(replaces.date!)})` : item.forHolidayDate ? fullDate(item.forHolidayDate) : '—'}
          </Text>
        ) : null}
        <IssueLine
          icon="document-text-outline"
          color="muted"
          text={item.sourceText ? `Document: ${item.sourceText}${item.printedWeekday ? ` · day: ${item.printedWeekday}` : ''}` : 'Added by hand'}
        />
        {[...blocking, ...checks].map((issue, i) => (
          <IssueLine
            key={i}
            icon={issue.severity === 'BLOCKING' ? 'alert-circle-outline' : 'warning-outline'}
            color={issue.severity === 'BLOCKING' ? 'missed' : 'exception'}
            text={issue.message}
            textClassName={issue.severity === 'BLOCKING' ? 'text-missed' : 'text-exception'}
          />
        ))}
        {info.map((issue, i) => (
          <IssueLine key={`info-${i}`} icon="information-circle-outline" color="muted" text={issue.message} />
        ))}
      </View>
      {canEdit ? (
        <View className="flex-row flex-wrap gap-2 border-t border-staff-line px-4 py-3">
          {checks.length > 0 && blocking.length === 0 ? (
            <SmallButton label="Confirm" icon="checkmark" tone="primary" onPress={onConfirm} loading={busy} accessibilityLabel={`Confirm ${item.date ?? 'row'}: the row matches the document`} />
          ) : null}
          <SmallButton label="Edit" icon="create-outline" onPress={onEdit} disabled={busy} accessibilityLabel={`Edit ${item.date ?? 'row'}`} />
          <SmallButton label="Delete" icon="trash-outline" tone="danger" onPress={onDelete} disabled={busy} accessibilityLabel={`Delete ${item.date ?? 'row'}`} />
        </View>
      ) : null}
    </Card>
  )
}

/** A small icon and a line of text inside an item card. */
const IssueLine: React.FC<{ icon: React.ComponentProps<typeof Icon>['name']; color: 'muted' | 'missed' | 'exception'; text: string; textClassName?: string }> = ({
  icon,
  color,
  text,
  textClassName = 'text-staff-muted'
}) => (
  <View className="flex-row gap-2">
    <View className="pt-px">
      <Icon name={icon} size={16} color={color} />
    </View>
    <Text className={`flex-1 text-[13px] leading-[18px] ${textClassName}`}>{text}</Text>
  </View>
)

/** The uploaded company document: images are shown here; every document can be downloaded to compare. */
const DocumentCard: React.FC<{ yearId: string; detail: CalendarYearDetail; version: string }> = ({ yearId, detail, version }) => {
  const notify = useToast()
  const { year } = detail
  const [downloading, setDownloading] = useState(false)
  const kind = !year.hasDocument
    ? null
    : year.sourceMimeType?.startsWith('image/')
      ? 'image'
      : year.sourceMimeType === 'application/pdf' || year.sourceFileName?.toLowerCase().endsWith('.pdf')
        ? 'pdf'
        : 'sheet'

  const download = async () => {
    setDownloading(true)
    try {
      await downloadAndShare(`/api/calendar-years/${yearId}/document`, year.sourceFileName ?? 'calendar', undefined, year.sourceMimeType ?? undefined)
    } catch (err) {
      notify('error', 'Could not download the document', errorText(err))
    } finally {
      setDownloading(false)
    }
  }

  if (!kind) {
    return (
      <Card>
        <View className="items-center px-5 py-7">
          <View className="mb-3 h-12 w-12 items-center justify-center rounded-full bg-staff-fill">
            <Icon name="document-outline" size={24} color="muted" />
          </View>
          <Text className="text-center text-[14px] leading-[19px] text-staff-muted">No document imported. The company document is shown here for checking each date.</Text>
        </View>
      </Card>
    )
  }

  return (
    <Card>
      <View className="flex-row items-center gap-3 px-4 py-3">
        <Icon name={kind === 'image' ? 'image-outline' : kind === 'pdf' ? 'document-text-outline' : 'grid-outline'} size={22} color="muted" />
        <View className="flex-1">
          <Text className="text-[15px] font-semibold leading-[20px] text-staff-ink" numberOfLines={2}>
            {year.sourceFileName ?? 'Company document'}
          </Text>
          <Text className="mt-0.5 text-[13px] leading-[18px] text-staff-muted">
            {kind === 'image' ? 'Tap the picture to enlarge it.' : kind === 'pdf' ? 'Open the PDF to compare each date.' : "Spreadsheets can't be previewed here. Open the file to compare."}
          </Text>
        </View>
      </View>
      {kind === 'image' ? <DocumentImage yearId={yearId} version={version} label={`${year.year} company calendar`} /> : null}
      <View className="border-t border-staff-line px-4 py-3">
        <SmallButton label={`Download ${year.sourceFileName ?? 'document'}`} icon="download-outline" onPress={download} loading={downloading} />
      </View>
    </Card>
  )
}

/** Fetched with the signed-in user's token, never public. */
const DocumentImage: React.FC<{ yearId: string; version: string; label: string }> = ({ yearId, version, label }) => {
  const [source, setSource] = useState<{ uri: string; headers?: Record<string, string> } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    const url = `${API_URL}/api/calendar-years/${yearId}/document`
    setSource(null)
    setError(null)
    ;(async () => {
      try {
        const headers = await authHeaders()
        if (Platform.OS === 'web') {
          const res = await fetch(url, { headers })
          if (!res.ok) throw new ApiError(res.status, await readError(res))
          objectUrl = URL.createObjectURL(await res.blob())
          if (!cancelled) setSource({ uri: objectUrl })
        } else if (!cancelled) {
          setSource({ uri: `${url}?v=${encodeURIComponent(version)}`, headers })
        }
      } catch (err) {
        if (!cancelled) setError(errorText(err))
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [yearId, version])

  if (error) return <Text className="px-4 pb-3 text-[14px] text-missed">{error}</Text>
  if (!source) return <Text className="px-4 py-8 text-center text-[14px] text-staff-muted">Loading document…</Text>
  return (
    <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="imagebutton" accessibilityLabel={`${label}, ${expanded ? 'show less' : 'show full'}`}>
      <Image source={source} resizeMode="contain" accessibilityLabel={label} className={`w-full bg-staff-fill ${expanded ? 'h-[560px]' : 'h-72'}`} />
    </Pressable>
  )
}

// ---------------------------------------------------------------- item form

/** Add a date, or edit one (saving marks the row as checked against the document). Manage only. */
export const CalendarYearItemFormScreen: React.FC<{ params: { yearId: string; itemId?: string } }> = ({ params }) => {
  const { pop } = useStaff()
  const notify = useToast()
  const { data, error, loading, reload } = useQuery<CalendarYearDetail>(`/api/calendar-years/${params.yearId}`)
  const item = params.itemId ? (data?.items.find((i) => i.id === params.itemId) ?? null) : null
  const [form, setForm] = useState<{ type: ClosureType; date: string; name: string; forHolidayDate: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const isEdit = !!params.itemId

  useEffect(() => {
    if (!data || form) return
    if (isEdit && !item) return
    setForm(
      item
        ? { type: item.type, date: item.date ?? '', name: item.name ?? '', forHolidayDate: item.forHolidayDate ?? '' }
        : { type: 'HOLIDAY', date: `${data.year.year}-01-01`, name: '', forHolidayDate: '' }
    )
  }, [data, item, form, isEdit])

  const year = data?.year.year
  const holidays = useMemo(
    () =>
      (data?.items ?? [])
        .filter((h) => h.type !== 'WORKING' && h.date)
        .sort((a, b) => a.date!.localeCompare(b.date!)),
    [data]
  )
  const set = <K extends keyof NonNullable<typeof form>>(key: K, value: NonNullable<typeof form>[K]) => setForm((f) => (f ? { ...f, [key]: value } : f))

  const save = async () => {
    if (!form) return
    if (!form.date) return setFormError('Enter the date')
    setSaving(true)
    setFormError(null)
    const body = { type: form.type, date: form.date, name: form.name.trim() || null, forHolidayDate: form.type === 'WORKING' ? form.forHolidayDate || null : null }
    try {
      if (isEdit) await api.put<CalendarYearDetail>(`/api/calendar-years/${params.yearId}/items/${params.itemId}`, body)
      else await api.post<CalendarYearDetail>(`/api/calendar-years/${params.yearId}/items`, body)
      notify('success', isEdit ? 'Date saved and checked' : 'Date added')
      pop()
    } catch (err) {
      setFormError(errorText(err))
      setSaving(false)
    }
  }

  return (
    <Screen
      title={isEdit ? 'Edit date' : 'Add date'}
      subtitle={isEdit ? 'Saving marks the row as checked against the document' : year ? `Add a date to the ${year} calendar` : null}
      footer={form ? <PrimaryButton label={isEdit ? 'Save and mark checked' : 'Add date'} onPress={save} loading={saving} /> : undefined}
    >
      <DataState loading={loading} error={error} onRetry={reload} hasData={!!data} empty={!!data && isEdit && !item} emptyText="This date could not be found." emptyIcon="calendar-outline">
        {form && year ? (
          <>
            <FormError message={formError} />
            {item?.sourceText ? <Notice icon="document-text-outline" title="Read from document:" message={item.sourceText} /> : null}
            <FormSection title="Type">
              <View>
                <FieldLabel label="Type" required />
                <View className="gap-2" accessibilityRole="radiogroup" accessibilityLabel="Type">
                  {ITEM_TYPES.map((t) => {
                    const active = form.type === t
                    const meta = CLOSURE_META[t]
                    return (
                      <Pressable
                        key={t}
                        onPress={() => set('type', t)}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: active }} aria-checked={active}
                        accessibilityLabel={TYPE_INFO[t].label}
                        className={`min-h-[56px] flex-row items-center gap-3 rounded-xl border px-3.5 py-2.5 active:bg-staff-fill ${
                          active ? 'border-2 border-staff-accent bg-staff-accent-soft' : 'border-staff-field bg-staff-card'
                        }`}
                      >
                        <View className={`h-3 w-3 rounded-full ${meta.dot}`} />
                        <View className="flex-1">
                          <Text className={`text-[15px] font-semibold leading-[20px] ${active ? 'text-staff-accent' : 'text-staff-ink'}`}>{TYPE_INFO[t].label}</Text>
                          <Text className="text-[13px] leading-[18px] text-staff-muted">{TYPE_INFO[t].hint}</Text>
                        </View>
                        {active ? <Icon name="checkmark-circle" size={22} color="accent" /> : null}
                      </Pressable>
                    )
                  })}
                </View>
              </View>
            </FormSection>
            <FormSection title="Date">
              <DateField
                label="Date"
                required
                value={form.date}
                min={`${year}-01-01`}
                max={`${year}-12-31`}
                hint={form.date ? weekdayName(form.date) : undefined}
                onChange={(v) => set('date', v)}
              />
              {form.type === 'WORKING' ? (
                <SelectField
                  label="Replaces holiday"
                  hint="The holiday this working day makes up for"
                  value={form.forHolidayDate}
                  emptyLabel="Not linked"
                  options={holidays.map((h) => ({ value: h.date!, label: `${fullDate(h.date!)} · ${h.name ?? 'Holiday'}` }))}
                  onChange={(v) => set('forHolidayDate', v)}
                />
              ) : null}
            </FormSection>
            <FormSection title="Details">
              <Input
                label={form.type === 'WORKING' ? 'Note' : 'Holiday name'}
                hint={form.type === 'WORKING' ? 'Optional' : undefined}
                value={form.name}
                maxLength={200}
                placeholder={form.type === 'WORKING' ? 'e.g. Adjustment for Diwali' : 'e.g. Diwali'}
                onChangeText={(v) => set('name', v)}
              />
            </FormSection>
          </>
        ) : null}
      </DataState>
    </Screen>
  )
}

export const CALENDAR_YEARS_SCREENS = {
  calendarYears: CalendarYearsScreen,
  calendarYearNew: CalendarYearNewScreen,
  calendarYearDetail: CalendarYearDetailScreen,
  calendarYearItemForm: CalendarYearItemFormScreen
}
