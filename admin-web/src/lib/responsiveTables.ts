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

/*
 * Relabels only the tables a change touched, once per frame. Changes outside tables (the Topbar
 * clock ticks every second) cost one closest() lookup and relabel nothing. Text changes are still
 * watched, but only for the table they happen in: a cell going from "—" to a value must lose its
 * data-empty mark. Our own data-label writes are attribute changes and are not observed.
 */
export function startResponsiveTables() {
  const pending = new Set<HTMLTableElement>()
  let queued = false
  const flush = () => {
    queued = false
    for (const table of pending) if (table.isConnected) labelTable(table)
    pending.clear()
  }
  const add = (table: HTMLTableElement) => {
    pending.add(table)
    if (queued) return
    queued = true
    requestAnimationFrame(flush)
  }
  // The table a changed node sits in, or (for a newly added page or panel) the tables inside it.
  const collect = (node: Node) => {
    const el = node instanceof Element ? node : node.parentElement
    const table = el?.closest<HTMLTableElement>('table.stack-sm')
    if (table) add(table)
    else if (node instanceof Element) node.querySelectorAll<HTMLTableElement>('table.stack-sm').forEach(add)
  }

  new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') {
        collect(record.target)
        continue
      }
      if (record.target instanceof Element && record.target.closest('table.stack-sm')) collect(record.target)
      else record.addedNodes.forEach(collect)
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true })
  document.querySelectorAll<HTMLTableElement>('table.stack-sm').forEach(add)
}
