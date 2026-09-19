import React, { useCallback, useEffect, useState } from 'react'
import { View, Text, ScrollView, RefreshControl, Pressable, Image } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, fileUrl, getHistory, getHistoryFilters } from '../services/api'
import { HistoryFilterOptions, HistoryItem, HistoryPage, HistoryQuery } from '../types'
import { formatTime } from '../utils/format'
import { formatDateKey } from '../utils/dates'
import { LargeHeader } from '../components/ui/LargeHeader'
import { ListGroup } from '../components/ui/ListGroup'
import { StatusLabel } from '../components/ui/StatusLabel'
import { Icon } from '../components/ui/Icon'
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import { HistoryFilters } from '../components/HistoryFilters'
import { formatShortWeekdayDate } from '../utils/datetime'

interface Props {
  refreshKey: number
  onOpenRecord: (checkId: string) => void
}

const PAGE_SIZE = 10

const KINDS: { key: NonNullable<HistoryQuery['kind']>; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'CHECK', label: 'Checks' },
  { key: 'EXCEPTION', label: 'Exceptions' }
]

function dayLabel(iso: string) {
  const date = new Date(iso)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return formatShortWeekdayDate(date)
}

const HistoryRow: React.FC<{ item: HistoryItem; onPress: () => void }> = ({ item, onPress }) => {
  const when = item.submittedAt ?? item.scheduledAt
  const extra = item.exceptionReason ?? (item.jobNo ? `Job No. ${item.jobNo}` : null)
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.machineName}, ${item.activityName}, ${dayLabel(when)} ${formatTime(when)}`}
      className="min-h-[76px] flex-row items-center py-3 pl-4 pr-3 active:bg-subtle"
    >
      {item.photoUrl ? (
        <Image source={{ uri: fileUrl(item.photoUrl) }} className="mr-3 h-12 w-12 rounded-[10px] bg-subtle" resizeMode="cover" />
      ) : (
        <View className="mr-3 h-12 w-12 items-center justify-center rounded-[10px] bg-subtle">
          <Icon name={item.hasVideo ? 'videocam-outline' : 'document-text-outline'} size={20} color="faint" />
        </View>
      )}

      <View className="flex-1">
        <View className="flex-row items-baseline">
          <Text className="flex-1 text-[17px] font-semibold text-ink" numberOfLines={1}>
            {item.machineName}
          </Text>
          <Text className="ml-2 text-[14px] text-ink-muted">{formatTime(when)}</Text>
        </View>
        <Text className="mt-0.5 text-[14px] text-ink-secondary" numberOfLines={1}>
          {item.activityName}
        </Text>
        <View className="mt-1 flex-row items-center">
          <StatusLabel status={item.status} />
          {extra ? (
            <Text className="ml-2 flex-1 text-[14px] text-ink-muted" numberOfLines={1}>
              · {extra}
            </Text>
          ) : null}
        </View>
      </View>

      <View className="ml-1">
        <Icon name="chevron-forward" size={18} color="faint" />
      </View>
    </Pressable>
  )
}

/** Records grouped by day, keeping the server's order. */
function byDay(items: HistoryItem[]) {
  const groups: { day: string; items: HistoryItem[] }[] = []
  for (const item of items) {
    const day = dayLabel(item.submittedAt ?? item.scheduledAt)
    const last = groups[groups.length - 1]
    if (last && last.day === day) last.items.push(item)
    else groups.push({ day, items: [item] })
  }
  return groups
}

export const HistoryScreen: React.FC<Props> = ({ refreshKey, onOpenRecord }) => {
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState<HistoryQuery>({ page: 1, pageSize: PAGE_SIZE, kind: 'ALL' })
  const [data, setData] = useState<HistoryPage | null>(null)
  const [options, setOptions] = useState<HistoryFilterOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await getHistory(query))
      setError(null)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Please try again.')
    }
  }, [query])

  useEffect(() => {
    load()
  }, [load, refreshKey])

  useEffect(() => {
    getHistoryFilters()
      .then(setOptions)
      .catch(() => undefined)
  }, [refreshKey])

  const goToPage = (page: number) => setQuery((q) => ({ ...q, page }))
  const applyFilters = (next: HistoryQuery) => {
    setQuery({ ...next, page: 1, pageSize: PAGE_SIZE })
    setFiltersOpen(false)
  }
  const clearFilters = () => setQuery({ page: 1, pageSize: PAGE_SIZE, kind: query.kind })

  const machineName = options?.machines.find((m) => m.id === query.machineId)?.name
  const departmentName = options?.departments.find((d) => d.id === query.departmentId)?.name
  const dateLabel = query.from || query.to ? `${query.from ? formatDateKey(query.from) : 'Any'} – ${query.to ? formatDateKey(query.to) : 'Today'}` : null
  const activeFilters = [dateLabel, machineName, departmentName].filter(Boolean) as string[]

  const page = data?.page ?? 1
  const totalPages = data?.totalPages ?? 1

  return (
    <View className="flex-1 bg-canvas" style={{ paddingTop: insets.top }}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="px-5 pb-10"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true)
              await load()
              setRefreshing(false)
            }}
          />
        }
      >
        <LargeHeader
          title="History"
          subtitle={data ? `${data.total} ${data.total === 1 ? 'record' : 'records'}` : 'Everything you sent in'}
        />

        {/* Check / exception switch: iOS-style segmented control */}
        <View className="h-11 flex-row rounded-xl bg-line p-[3px]" accessibilityRole="tablist">
          {KINDS.map((k) => {
            const selected = (query.kind ?? 'ALL') === k.key
            return (
              <Pressable
                key={k.key}
                onPress={() => setQuery((q) => ({ ...q, kind: k.key, page: 1 }))}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                className={`flex-1 items-center justify-center rounded-[9px] ${selected ? 'bg-surface' : 'active:opacity-60'}`}
              >
                <Text className={`text-[15px] ${selected ? 'font-semibold text-ink' : 'font-medium text-ink-secondary'}`}>{k.label}</Text>
              </Pressable>
            )
          })}
        </View>

        {/* Filters: one light row that says what is applied */}
        <View className="mt-3 flex-row items-center">
          <Pressable
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Filters${activeFilters.length ? `: ${activeFilters.join(', ')}` : ''}`}
            className="h-12 flex-1 flex-row items-center active:opacity-60"
          >
            <Icon name="options-outline" size={20} color="accent" />
            <Text className="ml-2 text-[16px] font-medium text-accent">Filters</Text>
            <Text className="ml-2 flex-1 text-[15px] text-ink-muted" numberOfLines={1}>
              {activeFilters.length ? activeFilters.join(' · ') : 'All dates and machines'}
            </Text>
          </Pressable>
          {activeFilters.length > 0 ? (
            <Pressable
              onPress={clearFilters}
              accessibilityRole="button"
              accessibilityLabel="Clear filters"
              className="h-12 justify-center pl-3 active:opacity-50"
            >
              <Text className="text-[15px] font-medium text-accent">Clear</Text>
            </Pressable>
          ) : null}
        </View>

        <View className="mt-4">
          {data === null && error ? (
            <ErrorState message={error} onRetry={load} />
          ) : data === null ? (
            <Loading />
          ) : data.items.length === 0 ? (
            <EmptyState
              icon={activeFilters.length ? 'search-outline' : 'time-outline'}
              title="Nothing found"
              message={activeFilters.length ? 'Try changing the filters.' : 'Checks you submit will show here.'}
              action={activeFilters.length ? { label: 'Clear filters', onPress: clearFilters } : undefined}
            />
          ) : (
            <>
              <View className="gap-6">
                {byDay(data.items).map((group) => (
                  <View key={group.day}>
                    <Text className="mb-2 px-4 text-[15px] font-semibold text-ink-muted">{group.day}</Text>
                    <ListGroup inset="thumbnail">
                      {group.items.map((item) => (
                        <HistoryRow key={item.id} item={item} onPress={() => onOpenRecord(item.id)} />
                      ))}
                    </ListGroup>
                  </View>
                ))}
              </View>

              {/* Pagination, kept quiet */}
              {totalPages > 1 ? (
                <View className="mt-5 flex-row items-center justify-between">
                  <Pressable
                    onPress={() => goToPage(page - 1)}
                    disabled={page <= 1}
                    accessibilityRole="button"
                    accessibilityLabel="Previous"
                    className={`h-12 min-w-[96px] flex-row items-center active:opacity-50 ${page <= 1 ? 'opacity-40' : ''}`}
                  >
                    <Icon name="chevron-back" size={18} color="accent" />
                    <Text className="ml-0.5 text-[16px] text-accent">Previous</Text>
                  </Pressable>

                  <Text className="text-[14px] text-ink-muted">
                    Page {page} of {totalPages}
                  </Text>

                  <Pressable
                    onPress={() => goToPage(page + 1)}
                    disabled={page >= totalPages}
                    accessibilityRole="button"
                    accessibilityLabel="Next"
                    className={`h-12 min-w-[96px] flex-row items-center justify-end active:opacity-50 ${
                      page >= totalPages ? 'opacity-40' : ''
                    }`}
                  >
                    <Text className="mr-0.5 text-[16px] text-accent">Next</Text>
                    <Icon name="chevron-forward" size={18} color="accent" />
                  </Pressable>
                </View>
              ) : null}

              {error ? <Text className="mt-3 text-center text-[14px] text-missed">{error}</Text> : null}
            </>
          )}
        </View>
      </ScrollView>

      <HistoryFilters
        visible={filtersOpen}
        query={query}
        options={options}
        onApply={applyFilters}
        onClose={() => setFiltersOpen(false)}
      />
    </View>
  )
}
