# Admin Web Design System (MASTER)

The single source of truth for how every admin page looks and behaves. The Dashboard
(`src/pages/admin/DashboardPage.tsx`) is the reference implementation.

Direction: **light, minimal, data-first enterprise SaaS** (Swiss/minimal style). Calm surfaces, one
blue for actions, colour only where it carries meaning. No gradients, neon, dark themes, heavy
shadows, large rounded "cartoon" cards or decorative animation.

## 1. Tokens (`src/index.css` `@theme`)

| Role | Token / class | Value |
|---|---|---|
| Page background | `bg-canvas` | #F5F7FA |
| Card / surface | `bg-surface`, `.card` | #FFFFFF, 1px `border-line`, radius 10px, `--shadow-card` |
| Subtle fill (chips, segmented, icon tiles) | `bg-subtle` | #F1F4F8 |
| Hairlines | `border-line` / `border-line-strong` | #E4E8EE / #CFD6E0 |
| Text | `text-ink` → `text-ink-secondary` → `text-ink-muted` → `text-ink-faint` | all ≥ 4.5:1 |
| Action / selection | `bg-accent`, `text-accent`, `text-accent-strong`, `bg-accent-soft`, `ring-accent-line` | #2563EB family |
| Completed | `text-success`, `bg-success-bg`, `ring-success-line` | |
| Missed (critical) | `text-missed`, `bg-missed-bg`, `ring-missed-line` | |
| Exception (warning) | `text-exception`, `bg-exception-bg`, `ring-exception-line` | |
| Due / info | `text-due`, `bg-due-bg` | |
| Chart marks | `var(--color-chart-completed|missed|exception|open|primary)` | ≥ 3:1 on white |
| Overlay shadow | `shadow-[var(--shadow-pop)]` | menus, modals, tooltips |

Rules: never hard-code new hex colours or Tailwind palette colours (`text-blue-700`,
`bg-emerald-50`, `text-slate-400`…) in pages; use the tokens above. Status colours are for status
only.

## 2. Typography & density

- Base 14px (desktop), 16px below `lg` (touch). Font Inter.
- Page title 20px semibold (`PageHeader`). Card title 13.5px semibold (`CardHeader`).
- Body/table text 12.5–13px. Captions / meta 11.5–12px `text-ink-muted`. Minimum 11px anywhere.
- Numbers: `tabular-nums`. Big KPI numbers 26px semibold.
- Spacing scale 4/8: page sections `space-y-5`, grids `gap-4` (KPIs `gap-3`), card padding `p-4`.
- Uppercase only for table headers and small group labels.

## 3. Components (use these; do not re-create them inline)

| Need | Component | File |
|---|---|---|
| Page title row | `PageHeader` (`title`, short `description`, `info`, `icon`, `actions`, `tabs`) | `components/common/PageHeader.tsx` |
| Section surface | `Card` + `CardHeader` (`icon`, `title`, `subtitle`, `info`, `actions`) | `components/ui/Card.tsx` |
| Long help text | `InfoTip` (or `info` prop on PageHeader/CardHeader) | `components/ui/Card.tsx` |
| Empty content inside a card | `EmptyState` | `components/ui/Card.tsx` |
| Loading / error / empty for a whole data block | `DataState` | `components/common/DataState.tsx` |
| KPI tile | `StatCard` | `components/ui/StatCard.tsx` |
| Charts | `StackedBarChart`, `DonutChart`, `BarList`, `SegmentBar`, `ProgressBar`, `Sparkline`, `ChartLegend`, `STATUS_SERIES` | `components/ui/charts.tsx` |
| Table filter row | `Toolbar`, `ToolbarSpacer`, `SearchInput`, `Segmented`, `ResultCount` | `components/ui/Toolbar.tsx` |
| Icon-only action | `IconButton` (`label` required) | `components/ui/Toolbar.tsx` |
| Paging long client lists | `usePagination` + `Pagination` | `components/ui/Pagination.tsx` |
| Buttons | `Button` (`primary` once per view, `outline` secondary, `ghost` tertiary, `danger` destructive) | `components/common/Button.tsx` |
| Status | `StatusBadge`, `CheckStatusBadge` (soft pill + dot + text) | `components/common/StatusBadge.tsx` |
| Forms | `Field`, `TextInput`, `Select`, `TextArea`, `Toggle`, `MultiSelectList`, `FormError` | `components/common/Form.tsx` |
| Overlays | `Modal`, `Drawer`, `ConfirmModal`, `askConfirm`/`openDialog` | `components/common/*` |
| Monitoring filters | `FilterBar` | `components/common/FilterBar.tsx` |

## 4. Page pattern

```
<div className="space-y-5">
  <PageHeader icon={<Icon className="w-4.5 h-4.5" />} title="Machines" description="12 machines · 3 in maintenance"
              info="Long explanation moved here" actions={<Button variant="primary" icon={<Plus/>}>Add machine</Button>} />
  {/* optional KPI strip: 3–5 StatCards for the page's own numbers */}
  <Card className="overflow-hidden">
    <Toolbar> <SearchInput … /> <Segmented … /> <ToolbarSpacer/> <ResultCount … /> </Toolbar>
    <div className="overflow-x-auto"> <table className="data-table stack-sm"> … </table> </div>
    <Pagination … />
  </Card>
</div>
```

- Description: one short line (counts, scope). Paragraph-length explanations → `info` tooltip or
  `InfoTip` beside the relevant heading. Do not delete information; move it.
- A page may add a small KPI strip (`StatCard`s) computed from data it already loads. Never add
  new API calls a page's permission does not already cover.

## 5. Tables

- `<table className="data-table stack-sm">` inside a `Card` with `overflow-hidden`, wrapped in
  `<div className="overflow-x-auto">` (add `max-h-[…] overflow-y-auto` for a sticky header on long
  lists). `.data-table` gives compact rows, sticky uppercase headers, hairline dividers, hover tint.
  Remove old per-cell `py-2 px-3`, `bg-slate-50 … uppercase` thead classes.
- Numeric columns: `className="num"` on `th` and `td`.
- Status columns: `StatusBadge` / `CheckStatusBadge`, never coloured plain text alone.
- Secondary info under the primary cell text in `text-[11.5px] text-ink-muted` instead of extra columns.
- Row actions: right-aligned `IconButton`s (Edit = Pencil, Delete/Disable = Trash2/Ban with
  `tone="danger"`, View = Eye/ChevronRight). Keep a text `Button` only for the single main row
  action when it is clearer (e.g. "View"). Last cell gets `data-label=""`.
- More than ~25 rows rendered at once → `usePagination` (reset on filter change via `resetKey`).
  Exports (CSV / print) must still use the full filtered list.
- Keep `stack-sm` (phone card layout) and `lib/responsiveTables.ts` labelling working: header
  cells must stay plain text.

## 6. Filters & toolbars

- Search + segmented filters + selects live in a `Toolbar` at the top of the table card (or the
  shared `FilterBar` card for monitoring pages). Active filters are visibly highlighted.
- Segmented controls for 2–5 exclusive options (status / role tabs), with counts.

## 7. Charts

- Use only when they answer a question (trend, distribution, comparison). Legends always
  visible; values on hover/focus; screen-reader table/summary built in.
- Completed = green, Exception = amber, Missed = red, Open = slate. Don't invent other mappings.

## 8. Status hierarchy

- Critical (missed, failure, blocked): red pill / red number + `alert` dot on StatCard.
- Warning (exception, under review, maintenance): amber.
- Success (completed, active, resolved): green pill — but keep large areas neutral.
- Pending / open / inactive: neutral outline or slate pill.

## 9. Accessibility (non-negotiable)

- Text ≥ 4.5:1 (use tokens). Visible focus (global `:focus-visible`). Icon-only buttons need
  `aria-label` (`IconButton` does it). Decorative icons `aria-hidden`. Toggles expose
  `aria-pressed`/`aria-expanded`. Inputs labelled (`Field` or `aria-label`). Targets ≥ 24px desktop,
  ≥ 36px below `lg`. Respect reduced motion (global CSS handles it).

## 10. Functional guardrails

UI only. Do not change API calls, request bodies, permissions checks (`useCanManage`, `can`,
`useCanOpen`, delete permissions), business rules, routes, filters, exports or actions. Every
button, filter and action that exists must still exist and work.
