import React, { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Download, ExternalLink, Loader2, X } from 'lucide-react'
import { errorText, fetchBlob } from '../../lib/api'
import { useDialogFocus } from '../../lib/useDialogFocus'
import { Button } from './Button'

/**
 * A PDF shown inside the page, in a large dialog. The PDF is fetched with the signed-in user's
 * token (never in a link) and shown from a temporary blob URL. Nothing opens a new tab on its own,
 * so a pop-up blocker cannot stop it; while the server builds a large PDF the dialog says so.
 * "Open in new tab" and "Download" are offered once it is ready.
 */
export const PdfPreview: React.FC<{
  /** API path of the PDF; null: closed. */
  path: string | null
  title: string
  /** Shown while the PDF is being prepared, e.g. "37 checks". */
  detail?: string
  fileName?: string
  onClose: () => void
}> = ({ path, title, detail, fileName = 'preview.pdf', onClose }) => {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const ref = useDialogFocus<HTMLDivElement>(path !== null, onClose)
  const titleId = useId()
  const run = useRef(0)

  useEffect(() => {
    if (!path) return
    const id = ++run.current
    let objectUrl: string | null = null
    setUrl(null)
    setError(null)
    setSeconds(0)
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    fetchBlob(path)
      .then((blob) => {
        if (id !== run.current) return
        objectUrl = URL.createObjectURL(blob.type === 'application/pdf' ? blob : new Blob([blob], { type: 'application/pdf' }))
        setUrl(objectUrl)
      })
      .catch((err) => id === run.current && setError(errorText(err)))
      .finally(() => clearInterval(timer))
    return () => {
      // Closed (or another PDF asked for): a late answer is ignored and the memory is freed.
      run.current++
      clearInterval(timer)
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [path])

  if (!path) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/45 backdrop-blur-[2px]">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-6xl h-[94vh] sm:h-[90vh] bg-white rounded-lg shadow-[var(--shadow-pop)] border border-line flex flex-col overflow-hidden outline-none"
      >
        <div className="flex items-center justify-between gap-2 px-3 sm:px-4 h-14 border-b border-line shrink-0">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[14px] font-semibold text-ink truncate">
              {title}
            </h2>
            {detail && <p className="text-[12px] text-ink-muted truncate">{detail}</p>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {url && (
              <>
                <Button size="sm" variant="outline" icon={<ExternalLink className="w-3.5 h-3.5" />} onClick={() => window.open(url, '_blank')} className="hidden sm:inline-flex">
                  Open in new tab
                </Button>
                <a
                  href={url}
                  download={fileName}
                  className="inline-flex items-center gap-1.5 h-[40px] lg:h-8 px-3 rounded-md border border-line-strong bg-white text-[13px] font-medium text-ink hover:bg-subtle"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden />
                  Download
                </a>
              </>
            )}
            <button
              type="button"
              data-autofocus
              onClick={onClose}
              className="w-[40px] h-[40px] lg:w-8 lg:h-8 rounded-md flex items-center justify-center text-ink-muted hover:bg-subtle hover:text-ink"
              aria-label="Close preview"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-subtle">
          {url ? (
            <iframe src={url} title={title} className="w-full h-full border-0 bg-white" />
          ) : error ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
              <AlertCircle className="w-6 h-6 text-failed" aria-hidden />
              <p className="text-[14px] font-semibold text-ink">The PDF could not be prepared</p>
              <p className="text-[13px] text-ink-muted max-w-md">{error}</p>
            </div>
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-2 px-6 text-center" aria-live="polite">
              <Loader2 className="w-6 h-6 text-accent animate-spin" aria-hidden />
              <p className="text-[14px] font-semibold text-ink">Preparing the PDF…</p>
              <p className="text-[13px] text-ink-muted max-w-md">
                {detail ? `${detail}. ` : ''}A report with many checks and photos can take up to a minute.
                {seconds >= 3 ? ` ${seconds} s` : ''}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
