/**
 * Sideways-scrolling rows of tabs and filters (class `scroll-hint`).
 *
 * On a narrow screen such a row can hold more than fits. The row is marked with which side has
 * more (`data-more="left" | "right" | "both"`), and index.css fades that edge, so it is clear the row
 * scrolls. The chosen tab is scrolled into view when the row appears, so it is never hidden off
 * the edge. Rows are found as pages render (the same way as lib/responsiveTables.ts).
 */
const SELECTED = '[aria-current="page"], [aria-selected="true"], [aria-pressed="true"]'
const watched = new WeakSet<HTMLElement>()

function update(row: HTMLElement) {
  const max = row.scrollWidth - row.clientWidth
  const left = row.scrollLeft > 2
  const right = max - row.scrollLeft > 2
  const more = left && right ? 'both' : left ? 'left' : right ? 'right' : null
  if (more) {
    if (row.getAttribute('data-more') !== more) row.setAttribute('data-more', more)
  } else if (row.hasAttribute('data-more')) row.removeAttribute('data-more')
}

function revealSelected(row: HTMLElement) {
  const selected = row.querySelector<HTMLElement>(SELECTED)
  if (!selected || row.scrollWidth <= row.clientWidth) return
  const r = row.getBoundingClientRect()
  const s = selected.getBoundingClientRect()
  if (s.left < r.left || s.right > r.right) row.scrollLeft += s.left - r.left - (r.width - s.width) / 2
}

function watch(row: HTMLElement) {
  if (watched.has(row)) return
  watched.add(row)
  row.addEventListener('scroll', () => update(row), { passive: true })
  new ResizeObserver(() => update(row)).observe(row)
  revealSelected(row)
  update(row)
}

export function startScrollHints() {
  let queued = false
  const scan = () => {
    queued = false
    for (const row of document.querySelectorAll<HTMLElement>('.scroll-hint')) {
      if (watched.has(row)) {
        // The choice may have changed (another tab chosen, counts loaded): keep it in view.
        update(row)
      } else watch(row)
    }
  }
  new MutationObserver(() => {
    if (queued) return
    queued = true
    requestAnimationFrame(scan)
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'aria-selected', 'aria-current'] })
  scan()
}
