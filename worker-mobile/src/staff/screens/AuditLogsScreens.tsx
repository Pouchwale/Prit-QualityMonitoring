import React, { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'
import type { AuditLog } from '../types'
import { useStaff } from '../nav'
import { useQuery } from '../useQuery'
import { addDaysKey, dateKey, formatDateTime, formatKey } from '../format'
import {
  AccessDenied,
  Card,
  DataState,
  DateField,
  Icon,
  KV,
  List,
  PrimaryButton,
  Row,
  Screen,
  SearchField,
  Section,
  SelectField,
  Sheet,
  SmallButton,
  type IconName
} from '../ui'
import { SummaryHeader, facts } from './adminParts'

const ENTITIES = ['User', 'Parameter', 'Activity', 'Machine', 'Schedule', 'Shift', 'Department', 'PlantCalendar', 'QualityCheck', 'Exception', 'Settings']
const LIMITS = [100, 300, 500, 1000]
const DEFAULT_LIMIT = 300

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

const pretty = (value: unknown) => (value === null || value === undefined ? null : JSON.stringify(value, null, 2))

const defaultFrom = () => addDaysKey(dateKey(), -29)

/** Actions worth noticing in the list: refused attempts and deletions (shown in red). */
const isAlarming = (action: string) => {
  const a = action.toUpperCase()
  return a.includes('DENIED') || a.startsWith('DELETE') || a.startsWith('REMOVE')
}

const byUser = (log: AuditLog) => `${log.userName ?? 'System'}${log.role ? ` (${log.role})` : ''}`

/** Audit Logs: who changed what and when — configuration edits, check submissions and exception reviews. */
export const AuditLogsScreen: React.FC<{ params: Record<string, never> }> = () => {
  const { can, push } = useStaff()
  const allowed = can('audit_logs')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [entity, setEntity] = useState('')
  const [from, setFrom] = useState(defaultFrom)
  const [to, setTo] = useState(() => dateKey())
  const [limit, setLimit] = useState(DEFAULT_LIMIT)
  const [filtersOpen, setFiltersOpen] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 350)
    return () => clearTimeout(timer)
  }, [search])

  const { data, error, loading, reload } = useQuery<AuditLog[]>(allowed ? '/api/audit-logs' : null, { q, entity, from, to, limit })
  const logs = data ?? []

  const reset = () => {
    setSearch('')
    setQ('')
    setEntity('')
    setFrom(defaultFrom())
    setTo(dateKey())
    setLimit(DEFAULT_LIMIT)
  }

  if (!allowed) {
    return (
      <Screen title="Audit Logs">
        <AccessDenied message="Ask an Admin for access to Audit Logs." />
      </Screen>
    )
  }

  const period = from === to ? formatKey(from) : `${formatKey(from)} – ${formatKey(to)}`
  const rangeChanged = from !== defaultFrom() || to !== dateKey()
  const activeCount = (entity ? 1 : 0) + (rangeChanged ? 1 : 0) + (limit !== DEFAULT_LIMIT ? 1 : 0)

  return (
    <Screen title="Audit Logs" onRefresh={reload} refreshing={loading && !!data}>
      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Action, user, entity or ID…" accessibilityLabel="Search" />
        <View className="flex-row items-center gap-2">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1" contentContainerClassName="items-center gap-2 pr-1">
            <FilterChip label={period} icon="calendar-outline" onPress={() => setFiltersOpen(true)} />
            <FilterChip label={entity || 'All entities'} icon="cube-outline" onPress={() => setFiltersOpen(true)} />
            <FilterChip label={`${limit} rows`} icon="list-outline" onPress={() => setFiltersOpen(true)} />
          </ScrollView>
          <Pressable
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={activeCount ? `Filters, ${activeCount} active` : 'Filters'}
            hitSlop={{ top: 4, bottom: 4 }}
            className={`h-11 flex-row items-center gap-1.5 rounded-full px-3 ${activeCount ? 'bg-staff-accent-soft' : 'border border-staff-line bg-staff-card active:bg-staff-fill'}`}
          >
            <Icon name="options-outline" size={18} color={activeCount ? 'accent' : 'ink'} />
            <Text className={`text-[14px] font-semibold ${activeCount ? 'text-staff-accent' : 'text-staff-ink'}`}>Filters</Text>
          </Pressable>
        </View>
        <View className="min-h-[44px] flex-row items-center justify-between px-1">
          <Text className="text-[13px] text-staff-muted">
            {logs.length} entr{logs.length === 1 ? 'y' : 'ies'}
            {logs.length >= limit ? ' (limit reached)' : ''}
          </Text>
          <SmallButton label="Reset" tone="ghost" onPress={reset} />
        </View>
      </View>

      <DataState
        loading={loading}
        error={error}
        onRetry={reload}
        hasData={!!data}
        empty={!!data && logs.length === 0}
        emptyText="No audit entries match these filters."
        emptyIcon="document-text-outline"
      >
        <List>
          {logs.map((log) => (
            <Row
              key={log.id}
              title={log.action}
              titleClassName={isAlarming(log.action) ? 'text-missed' : ''}
              subtitle={facts(formatDateTime(log.createdAt), log.entity, byUser(log))}
              onPress={() => push('auditLogDetail', { log })}
            />
          ))}
        </List>
      </DataState>

      {filtersOpen ? (
        <Sheet
          title="Filters"
          onClose={() => setFiltersOpen(false)}
          closeLabel="Done"
          footer={
            <View className="flex-row gap-2">
              <SmallButton
                label="Reset"
                className="h-12"
                onPress={() => {
                  reset()
                  setFiltersOpen(false)
                }}
              />
              <View className="flex-1">
                <PrimaryButton label="Show entries" onPress={() => setFiltersOpen(false)} />
              </View>
            </View>
          }
        >
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 px-4 pb-4 pt-2">
            <SelectField label="Entity" value={entity} emptyLabel="All entities" options={ENTITIES.map((e) => ({ value: e, label: e }))} onChange={setEntity} />
            <View className="flex-row gap-2">
              <View className="flex-1">
                <DateField
                  label="From"
                  value={from}
                  max={to}
                  onChange={(v) => {
                    setFrom(v)
                    if (v && to && v > to) setTo(v)
                  }}
                />
              </View>
              <View className="flex-1">
                <DateField
                  label="To"
                  value={to}
                  min={from}
                  onChange={(v) => {
                    setTo(v)
                    if (v && from && v < from) setFrom(v)
                  }}
                />
              </View>
            </View>
            <SelectField label="Show" value={String(limit)} options={LIMITS.map((l) => ({ value: String(l), label: `${l} rows` }))} onChange={(v) => v && setLimit(Number(v))} />
          </ScrollView>
        </Sheet>
      ) : null}
    </Screen>
  )
}

/** A summary pill of the current filter; opens the filter sheet. */
const FilterChip: React.FC<{ label: string; icon: IconName; onPress: () => void }> = ({ label, icon, onPress }) => (
  <Pressable
    onPress={onPress}
    accessibilityRole="button"
    accessibilityLabel={label}
    hitSlop={{ top: 4, bottom: 4 }}
    className="h-11 flex-row items-center gap-1.5 rounded-full border border-staff-line bg-staff-card px-3.5 active:bg-staff-fill"
  >
    <Icon name={icon} size={16} color="ink2" />
    <Text className="text-[14px] font-medium text-staff-ink" numberOfLines={1}>
      {label}
    </Text>
  </Pressable>
)

const JsonBlock: React.FC<{ title: string; text: string | null; tone: 'missed' | 'success' }> = ({ title, text, tone }) => (
  <Section title={title}>
    <Card>
      <View className="flex-row items-center gap-2 px-4 pt-3">
        <View className={`h-2 w-2 rounded-full ${tone === 'missed' ? 'bg-missed' : 'bg-success'}`} />
        <Text className="text-[12px] font-medium text-staff-muted">JSON</Text>
      </View>
      {text === null ? (
        <Text className="px-4 pb-3 pt-1 text-[14px] text-staff-muted">—</Text>
      ) : (
        <Text selectable className="px-4 pb-3 pt-1 text-[13px] leading-5 text-staff-ink" style={{ fontFamily: MONO }}>
          {text}
        </Text>
      )}
    </Card>
  </Section>
)

/** One audit entry with its old and new values. */
export const AuditLogDetailScreen: React.FC<{ params: { log: AuditLog } }> = ({ params }) => {
  const { log } = params
  return (
    <Screen title="Audit entry">
      <SummaryHeader title={log.action} caption={facts(log.entity, log.userName ?? 'System', formatDateTime(log.createdAt))} />
      <Card>
        <KV stacked label="Time" value={formatDateTime(log.createdAt)} />
        <KV stacked label="User" value={log.userName ?? 'System'} />
        <KV stacked label="Role" value={log.role} />
        <KV stacked label="Entity" value={log.entity} />
        <KV
          stacked
          label="Entity ID"
          value={
            log.entityId ? (
              <Text selectable className="text-[14px] text-staff-ink" style={{ fontFamily: MONO }}>
                {log.entityId}
              </Text>
            ) : (
              '—'
            )
          }
        />
        <KV stacked label="IP address" value={log.ipAddress} />
      </Card>
      <JsonBlock title="Old value" text={pretty(log.oldValue)} tone="missed" />
      <JsonBlock title="New value" text={pretty(log.newValue)} tone="success" />
    </Screen>
  )
}

export const AUDIT_LOGS_SCREENS = {
  auditLogs: AuditLogsScreen,
  auditLogDetail: AuditLogDetailScreen
}
