import React, { useEffect, useState } from 'react'
import { Platform, Pressable, ScrollView, Text, View } from 'react-native'
import type { AuditLog } from '../types'
import { api, type Page, type Query } from '../../services/api'
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
  SelectField,
  Sheet,
  SmallButton,
  type IconName
} from '../ui'
import { SummaryHeader, facts } from './adminParts'

const ENTITIES = ['User', 'Parameter', 'Activity', 'Machine', 'Schedule', 'Shift', 'Department', 'PlantCalendar', 'QualityCheck', 'Exception', 'Settings']
const PER_PAGE = [25, 50, 100, 200]
const DEFAULT_PER_PAGE = 25

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

/** The server pages the log, so only one page of entries is ever loaded. */
const loadPage = (path: string, query?: Query) => api.getPage<AuditLog>(path, query)

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
  const [perPage, setPerPage] = useState(DEFAULT_PER_PAGE)
  const [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search.trim())
      setPage(1)
    }, 350)
    return () => clearTimeout(timer)
  }, [search])

  const { data, error, loading, reload } = useQuery<Page<AuditLog>>(
    allowed ? '/api/audit-logs' : null,
    { q, entity, from, to, limit: perPage, offset: (page - 1) * perPage },
    loadPage
  )
  const logs = data?.rows ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / perPage))
  const firstOnPage = total === 0 ? 0 : (page - 1) * perPage + 1
  const lastOnPage = (page - 1) * perPage + logs.length

  // Every filter returns to the first page itself; this only catches a page that no longer exists.
  useEffect(() => {
    if (data && page > totalPages) setPage(totalPages)
  }, [data, page, totalPages])

  const reset = () => {
    setSearch('')
    setQ('')
    setEntity('')
    setFrom(defaultFrom())
    setTo(dateKey())
    setPerPage(DEFAULT_PER_PAGE)
    setPage(1)
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
  const activeCount = (entity ? 1 : 0) + (rangeChanged ? 1 : 0) + (perPage !== DEFAULT_PER_PAGE ? 1 : 0)

  return (
    <Screen title="Audit Logs" onRefresh={reload} refreshing={loading && !!data}>
      <View className="gap-2">
        <SearchField value={search} onChangeText={setSearch} placeholder="Action, user, entity or ID…" accessibilityLabel="Search" />
        <View className="flex-row items-center gap-2">
          <ScrollView horizontal showsHorizontalScrollIndicator={false} className="flex-1" contentContainerClassName="items-center gap-2 pr-1">
            <FilterChip label={period} icon="calendar-outline" onPress={() => setFiltersOpen(true)} />
            <FilterChip label={entity || 'All entities'} icon="cube-outline" onPress={() => setFiltersOpen(true)} />
            <FilterChip label={`${perPage} per page`} icon="list-outline" onPress={() => setFiltersOpen(true)} />
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
            {total} entr{total === 1 ? 'y' : 'ies'}
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

      {/* Previous / Next: the server sends one page at a time, however many entries there are. */}
      <View className="mt-1 gap-2 px-1">
        <Text className="text-[13px] text-staff-muted">
          Showing {firstOnPage}–{lastOnPage} of {total}
        </Text>
        <View className="flex-row items-center justify-between gap-2">
          <SmallButton label="Previous" icon="chevron-back" disabled={page <= 1 || loading} onPress={() => setPage((p) => Math.max(1, p - 1))} />
          <Text className="text-[13px] font-semibold text-staff-ink">
            Page {page} of {totalPages}
          </Text>
          <SmallButton label="Next" icon="chevron-forward" disabled={page >= totalPages || loading} onPress={() => setPage((p) => Math.min(totalPages, p + 1))} />
        </View>
      </View>

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
            <SelectField
              label="Entity"
              value={entity}
              emptyLabel="All entities"
              options={ENTITIES.map((e) => ({ value: e, label: e }))}
              onChange={(v) => {
                setEntity(v)
                setPage(1)
              }}
            />
            <View className="flex-row gap-2">
              <View className="flex-1">
                <DateField
                  label="From"
                  value={from}
                  max={to}
                  onChange={(v) => {
                    setFrom(v)
                    if (v && to && v > to) setTo(v)
                    setPage(1)
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
                    setPage(1)
                  }}
                />
              </View>
            </View>
            <SelectField
              label="Rows per page"
              value={String(perPage)}
              options={PER_PAGE.map((l) => ({ value: String(l), label: `${l} rows` }))}
              onChange={(v) => {
                if (!v) return
                setPerPage(Number(v))
                setPage(1)
              }}
            />
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
    </Screen>
  )
}

export const AUDIT_LOGS_SCREENS = {
  auditLogs: AuditLogsScreen,
  auditLogDetail: AuditLogDetailScreen
}
