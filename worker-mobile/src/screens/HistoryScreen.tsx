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
import { EmptyState, ErrorState, Loading } from '../components/ui/LoadState'
import { HistoryFilters } from '../components/HistoryFilters'

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
  return date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

const HistoryRow: React.FC<{ item: HistoryItem; onPress: () => void }> = ({ item, onPress }) => {
  const when = item.submittedAt ?? item.scheduledAt
  return (
    <Pressable onPress={onPress} accessibilityRole="button" className="flex-row items-center px-4 py-3 active:bg-subtle">
      {item.photoUrl ? (
        <Image source={{ uri: fileUrl(item.photoUrl) }} className="mr-3 h-14 w-14 rounded-lg bg-subtle" resizeMode="cover" />
      ) : (
        <View className="mr-3 h-14 w-14 items-center justify-center rounded-lg bg-subtle">
          <Text className="text-[12px] text-ink-faint">No photo</Text>
        </View>
      )}

      <View className="flex-1">
        <Text className="text-[17px] font-semibold text-ink" numberOfLines={1}>
          {item.machineName}
        </Text>
        <Text className="mt-0.5 text-[14px] text-ink-muted" numberOfLines={1}>
          {dayLabel(when)} · {formatTime(when)}
          {item.departmentName ? ` · ${item.departmentName}` : ''}
        </Text>
        <View className="mt-1 flex-row items-center">
          <StatusLabel status={item.status} />
          {item.exceptionReason ? (
            <Text className="ml-2 flex-1 text-[14px] text-ink-muted" numberOfLines={1}>
              {item.exceptionReason}
            </Text>
          ) : item.jobNo ? (
            <Text className="ml-2 flex-1 text-[14px] text-ink-muted" numberOfLines={1}>
              Job No. {item.jobNo}
            </Text>
          ) : null}
        </View>
      </View>

      <Text className="ml-2 text-[24px] text-ink-faint">›</Text>
    </Pressable>
  )
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

        {/* Check / exception switch */}
        <View className="flex-row gap-3">
          {KINDS.map((k) => {
            const selected = (query.kind ?? 'ALL') === k.key
            return (
              <Pressable
                key={k.key}
                onPress={() => setQuery((q) => ({ ...q, kind: k.key, page: 1 }))}
                accessibilityRole="button"
                className={`h-12 flex-1 items-center justify-center rounded-xl border ${
                  selected ? 'border-accent bg-accent' : 'border-line-strong bg-surface active:bg-subtle'
                }`}
              >
                <Text className={`text-[16px] font-semibold ${selected ? 'text-white' : 'text-ink'}`}>{k.label}</Text>
              </Pressable>
            )
          })}
        </View>

        <Pressable
          onPress={() => setFiltersOpen(true)}
          accessibilityRole="button"
          className="mt-3 h-12 flex-row items-center justify-between rounded-xl border border-line-strong bg-surface px-4 active:bg-subtle"
        >
          <Text className="text-[16px] font-medium text-ink">
            Filters{activeFilters.length ? ` (${activeFilters.length})` : ''}
          </Text>
          <Text className="text-[16px] text-accent">Change</Text>
        </Pressable>

        {activeFilters.length > 0 && (
          <View className="mt-2 flex-row items-center">
            <Text className="flex-1 text-[14px] text-ink-muted" numberOfLines={2}>
              {activeFilters.join(' · ')}
            </Text>
            <Pressable
              onPress={() => setQuery({ page: 1, pageSize: PAGE_SIZE, kind: query.kind })}
              className="h-10 justify-center pl-3 active:opacity-50"
            >
              <Text className="text-[15px] font-medium text-accent">Clear</Text>
            </Pressable>
          </View>
        )}

        <View className="mt-6">
          {data === null && error ? (
            <ErrorState message={error} onRetry={load} />
          ) : data === null ? (
            <Loading />
          ) : data.items.length === 0 ? (
            <EmptyState
              title="Nothing found"
              message={activeFilters.length ? 'Try changing the filters.' : 'Checks you submit will show here.'}
            />
          ) : (
            <>
              <ListGroup>
                {data.items.map((item) => (
                  <HistoryRow key={item.id} item={item} onPress={() => onOpenRecord(item.id)} />
                ))}
              </ListGroup>

              {/* Pagination */}
              <View className="mt-4 flex-row items-center justify-between">
                <Pressable
                  onPress={() => goToPage(page - 1)}
                  disabled={page <= 1}
                  accessibilityRole="button"
                  className={`h-12 w-28 items-center justify-center rounded-xl border border-line-strong bg-surface active:bg-subtle ${
                    page <= 1 ? 'opacity-40' : ''
                  }`}
                >
                  <Text className="text-[16px] font-medium text-ink">‹ Previous</Text>
                </Pressable>

                <Text className="text-[15px] text-ink-muted">
                  Page {page} of {totalPages}
                </Text>

                <Pressable
                  onPress={() => goToPage(page + 1)}
                  disabled={page >= totalPages}
                  accessibilityRole="button"
                  className={`h-12 w-28 items-center justify-center rounded-xl border border-line-strong bg-surface active:bg-subtle ${
                    page >= totalPages ? 'opacity-40' : ''
                  }`}
                >
                  <Text className="text-[16px] font-medium text-ink">Next ›</Text>
                </Pressable>
              </View>

              {error ? <Text className="mt-3 text-center text-[14px] text-failed">{error}</Text> : null}
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
