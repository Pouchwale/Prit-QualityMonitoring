import React, { useCallback, useMemo, useState } from 'react'
import { Trash2, X } from 'lucide-react'
import { Button } from './Button'

/** Most records one bulk delete may take; the server refuses more. */
export const MAX_BULK = 200

/**
 * Checkbox selection for bulk delete. Only rows currently on screen count: a row that is filtered
 * away drops out of the selection, so nothing hidden is ever deleted.
 */
export function useSelection(visibleIds: string[]) {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const visibleKey = visibleIds.join(',')
  const selected = useMemo(() => {
    const visible = new Set(visibleKey ? visibleKey.split(',') : [])
    return [...picked].filter((id) => visible.has(id))
  }, [picked, visibleKey])

  const toggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else if (next.size < MAX_BULK) next.add(id)
      return next
    })
  }, [])
  const allChecked = visibleIds.length > 0 && visibleIds.every((id) => picked.has(id))
  const toggleAll = useCallback(() => {
    setPicked(allChecked ? new Set() : new Set(visibleIds.slice(0, MAX_BULK)))
  }, [allChecked, visibleIds])
  const clear = useCallback(() => setPicked(new Set()), [])
  return { selected, isSelected: (id: string) => picked.has(id), toggle, toggleAll, allChecked, clear }
}

export const RowCheckbox: React.FC<{ checked: boolean; onChange: () => void; label: string; disabled?: boolean }> = ({ checked, onChange, label, disabled }) => (
  <input
    type="checkbox"
    className="w-4 h-4 accent-[var(--color-failed)] cursor-pointer disabled:cursor-not-allowed"
    checked={checked}
    onChange={onChange}
    onClick={(e) => e.stopPropagation()}
    disabled={disabled}
    aria-label={label}
  />
)

/** Shown while rows are selected: the count, Clear, and Delete selected. There is no "delete all". */
export const BulkDeleteBar: React.FC<{ count: number; noun: string; onClear: () => void; onDelete: () => void }> = ({ count, noun, onClear, onDelete }) =>
  count === 0 ? null : (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-failed-line bg-failed-bg px-3 py-2 text-xs" role="region" aria-label="Selection">
      <span className="font-semibold text-ink">
        {count} {noun} selected{count >= MAX_BULK ? ` (the most at once is ${MAX_BULK})` : ''}
      </span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" onClick={onClear} icon={<X className="w-3 h-3" />}>
          Clear
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete} icon={<Trash2 className="w-3 h-3" />}>
          Delete selected
        </Button>
      </div>
    </div>
  )
