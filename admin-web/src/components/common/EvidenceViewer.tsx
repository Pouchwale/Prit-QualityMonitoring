import React, { useState } from 'react'
import { Camera, Maximize2, Play, ShieldCheck, Video, X } from 'lucide-react'
import type { MediaFile } from '../../types'
import { mediaUrl } from '../../lib/api'
import { formatBytes, formatDateTime } from '../../lib/format'
import { useDialogFocus } from '../../lib/useDialogFocus'

interface EvidenceViewerProps {
  media: MediaFile[]
  /** Context shown in the metadata strip. */
  workerName?: string | null
  deviceInfo?: string | null
  compact?: boolean
  /**
   * Heading of this group of evidence, e.g. a parameter name or "Overall evidence".
   * Defaults to "Live camera evidence".
   */
  label?: string
  className?: string
}

/** Shows live-captured photo and video evidence with capture metadata. */
export const EvidenceViewer: React.FC<EvidenceViewerProps> = ({ media, workerName, deviceInfo, compact = false, label, className = '' }) => {
  const [preview, setPreview] = useState<MediaFile | null>(null)
  const photos = media.filter((m) => m.kind === 'PHOTO')
  const videos = media.filter((m) => m.kind === 'VIDEO')

  if (media.length === 0) {
    return (
      <div className={`flex items-center justify-center gap-2 px-4 py-5 rounded-lg border border-dashed border-line-strong bg-subtle text-[12px] text-ink-muted ${className}`}>
        <Camera className="w-4 h-4 text-ink-faint" aria-hidden />
        No photo or video attached{label ? ` for ${label}` : ''}
      </div>
    )
  }

  if (compact) {
    // Table cells: the first photo and a play tile for video, with a "+N" when there is more.
    const shown = photos.slice(0, 1).length + (videos.length > 0 ? 1 : 0)
    const more = media.length - shown
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        {photos.slice(0, 1).map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPreview(p)}
            className="w-[44px] h-[44px] lg:w-9 lg:h-9 shrink-0 rounded-md overflow-hidden ring-1 ring-line-strong hover:ring-accent transition-shadow"
            aria-label={`Open evidence photo${p.capturedAt ? ` captured ${formatDateTime(p.capturedAt)}` : ''}`}
            title="Open photo"
          >
            <img src={mediaUrl(p.url)} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
          </button>
        ))}
        {videos.length > 0 && (
          <button
            type="button"
            onClick={() => setPreview(videos[0])}
            className="w-[44px] h-[44px] lg:w-9 lg:h-9 shrink-0 rounded-md ring-1 ring-line-strong bg-ink text-white flex items-center justify-center hover:ring-accent"
            title="Play video"
            aria-label="Play evidence video"
          >
            <Video className="w-4 h-4" aria-hidden />
          </button>
        )}
        {more > 0 && (
          <span className="text-[11px] font-medium text-ink-muted tabular-nums" title={`${media.length} files in total`}>
            +{more}
          </span>
        )}
        {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
      </div>
    )
  }

  return (
    <div className={`rounded-lg border border-line bg-white overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line text-[12.5px] font-semibold text-ink">
        <ShieldCheck className="w-4 h-4 text-success shrink-0" aria-hidden />
        <span className="truncate">{label ?? 'Live camera evidence'}</span>
        {label && <span className="text-[11.5px] font-normal text-ink-muted whitespace-nowrap">· live camera</span>}
        <span className="ml-auto text-[11.5px] font-normal text-ink-muted tabular-nums whitespace-nowrap">
          {[photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'}` : null, videos.length ? `${videos.length} video${videos.length === 1 ? '' : 's'}` : null]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>

      {/* Gallery: one tile per file, the picture on a dark mat and its capture details below. */}
      <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
        {[...photos, ...videos].map((file) => (
          <figure key={file.id} className="min-w-0 rounded-md border border-line overflow-hidden">
            <div className="relative bg-ink flex items-center justify-center h-56">
              {file.kind === 'PHOTO' ? (
                <button
                  type="button"
                  onClick={() => setPreview(file)}
                  className="group/zoom w-full h-full flex items-center justify-center cursor-zoom-in"
                  aria-label={`Enlarge evidence photo${file.capturedAt ? ` captured ${formatDateTime(file.capturedAt)}` : ''}`}
                >
                  <img src={mediaUrl(file.url)} alt="" loading="lazy" decoding="async" className="max-h-56 w-full object-contain" />
                  <span className="absolute top-2 right-2 w-7 h-7 rounded-md bg-white/90 text-ink flex items-center justify-center opacity-0 group-hover/zoom:opacity-100 group-focus-visible/zoom:opacity-100 transition-opacity" aria-hidden>
                    <Maximize2 className="w-3.5 h-3.5" />
                  </span>
                </button>
              ) : (
                <video src={mediaUrl(file.url)} controls preload="metadata" className="max-h-56 w-full" aria-label="Evidence video" />
              )}
            </div>
            <figcaption className="px-3 py-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
              <Meta label={file.kind === 'PHOTO' ? 'Photo captured' : 'Video captured'} value={formatDateTime(file.capturedAt)} />
              <Meta label="Size" value={sizeText(file)} title={storageNote(file)} />
              <Meta label="SHA-256" value={`${file.sha256.slice(0, 16)}…`} mono title={file.sha256} />
              <Meta label="Uploaded" value={formatDateTime(file.createdAt)} />
            </figcaption>
          </figure>
        ))}
      </div>

      {(workerName || deviceInfo) && (
        <div className="px-3 py-2 border-t border-line grid grid-cols-2 gap-3 bg-subtle/60">
          {workerName && <Meta label="Captured by" value={workerName} />}
          {deviceInfo && <Meta label="Device" value={deviceInfo} />}
        </div>
      )}

      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

/** "420 KB · 1420×3072 · 12 s" */
function sizeText(file: MediaFile) {
  return [
    formatBytes(file.sizeBytes),
    file.width && file.height ? `${file.width}×${file.height}` : null,
    file.durationSeconds != null ? `${Math.round(file.durationSeconds)} s` : null
  ]
    .filter(Boolean)
    .join(' · ')
}

/** How the file was stored, shown on hover: "Compressed from 2.0 MB". */
function storageNote(file: MediaFile) {
  if (file.processing === 'PENDING') return 'Being compressed; the uploaded video is shown until then.'
  if (file.processing === 'COMPRESSED' && file.originalSizeBytes) return `Compressed for storage from ${formatBytes(file.originalSizeBytes)}`
  if (file.processing === 'FAILED') return 'Stored as uploaded (it could not be compressed).'
  return 'Stored as uploaded.'
}

const Meta: React.FC<{ label: string; value: string; mono?: boolean; title?: string }> = ({ label, value, mono, title }) => (
  <div className="min-w-0">
    <div className="text-[11px] text-ink-muted">{label}</div>
    <div className={`text-[12px] font-medium text-ink truncate ${mono ? 'font-mono' : ''}`} title={title ?? value}>
      {value}
    </div>
  </div>
)

/** The photo or video at full size. Escape, the backdrop or Close shuts it; focus returns to the thumbnail. */
const PreviewModal: React.FC<{ file: MediaFile; onClose: () => void }> = ({ file, onClose }) => {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose)
  const what = file.kind === 'PHOTO' ? 'Evidence photo' : 'Evidence video'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/90 p-4" onClick={onClose}>
      <div
        className="relative max-w-5xl w-full outline-none"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${what} captured ${formatDateTime(file.capturedAt)}`}
        ref={dialogRef}
        tabIndex={-1}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-11 right-0 w-10 h-10 flex items-center justify-center rounded-md text-white/80 hover:text-white hover:bg-white/10"
          aria-label={`Close ${what.toLowerCase()}`}
          data-autofocus
        >
          <X className="w-5 h-5" />
        </button>
        {file.kind === 'PHOTO' ? (
          <img src={mediaUrl(file.url)} alt={`${what} captured ${formatDateTime(file.capturedAt)}`} className="max-h-[85vh] w-full object-contain rounded-md" />
        ) : (
          <video src={mediaUrl(file.url)} controls autoPlay className="max-h-[85vh] w-full rounded-md bg-ink" />
        )}
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-white/80 font-mono break-all">
          {file.kind === 'VIDEO' && <Play className="w-3 h-3 shrink-0" aria-hidden />}
          Captured {formatDateTime(file.capturedAt)} · SHA-256 {file.sha256}
        </div>
      </div>
    </div>
  )
}
