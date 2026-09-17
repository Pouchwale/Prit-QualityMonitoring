/**
 * Phone layout for list tables.
 *
 * A table with the `stack-sm` class is shown as one card per row below the md breakpoint
 * (see index.css): the header row is hidden and every cell shows its column name in front of
 * its value. The column names come from the table's own <th> cells, copied here into a
 * `data-label` attribute, so a table only needs the class — no duplicated card markup.
 *
 * Cells are relabelled whenever the page changes (rows loading, filtering, paging).
 */
const EMPTY_VALUE = /^\s*[—–-]?\s*$/

function labelTable(table: HTMLTableElement) {
  const headerRow = table.tHead?.rows[0]
  if (!headerRow) return

  // Column index → header text, honouring colspans in the header.
  const labels: string[] = []
  for (const th of Array.from(headerRow.cells)) {
    const text = th.textContent?.trim() ?? ''
    for (let i = 0; i < th.colSpan; i++) labels.push(text)
  }

  for (const body of Array.from(table.tBodies)) {
    for (const row of Array.from(body.rows)) {
      let column = 0
      for (const cell of Array.from(row.cells)) {
        // A cell spanning the whole row (empty state, expanded details) gets no label.
        const label = cell.colSpan > 1 ? '' : (labels[column] ?? '')
        if (cell.getAttribute('data-label') !== label) cell.setAttribute('data-label', label)
        // Mark cells that only show a placeholder dash so the phone card can skip them.
        const empty = cell.colSpan === 1 && !cell.querySelector('img, svg, button, input, select, video') && EMPTY_VALUE.test(cell.textContent ?? '')
        if (empty !== cell.hasAttribute('data-empty')) cell.toggleAttribute('data-empty', empty)
        column += cell.colSpan
      }
    }
  }
}

function labelAll() {
  document.querySelectorAll<HTMLTableElement>('table.stack-sm').forEach(labelTable)
}

export function startResponsiveTables() {
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      labelAll()
    })
  }
  // Only structural changes matter; our own data-label writes are attribute changes and are ignored.
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true })
  schedule()
}
