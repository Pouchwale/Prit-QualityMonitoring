import React, { useState } from 'react'
import { Camera, ShieldCheck, Video, X } from 'lucide-react'
import type { MediaFile } from '../../types'
import { mediaUrl } from '../../lib/api'
import { formatBytes, formatDateTime } from '../../lib/format'

interface EvidenceViewerProps {
  media: MediaFile[]
  /** Context shown in the metadata strip. */
  workerName?: string | null
  deviceInfo?: string | null
  compact?: boolean
  className?: string
}

/** Shows live-captured photo and video evidence with capture metadata. */
export const EvidenceViewer: React.FC<EvidenceViewerProps> = ({ media, workerName, deviceInfo, compact = false, className = '' }) => {
  const [preview, setPreview] = useState<MediaFile | null>(null)
  const photos = media.filter((m) => m.kind === 'PHOTO')
  const videos = media.filter((m) => m.kind === 'VIDEO')

  if (media.length === 0) {
    return (
      <div className={`p-4 rounded border border-dashed border-line bg-slate-50 text-center text-xs text-ink-muted ${className}`}>
        <Camera className="w-5 h-5 mx-auto mb-1.5 text-ink-faint" />
        No photo or video attached
      </div>
    )
  }

  if (compact) {
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        {photos.slice(0, 1).map((p) => (
          <img
            key={p.id}
            src={mediaUrl(p.url)}
            alt="Evidence"
            className="w-[44px] h-[44px] lg:w-10 lg:h-10 shrink-0 object-cover rounded border border-line-strong cursor-pointer hover:border-accent"
            onClick={() => setPreview(p)}
          />
        ))}
        {videos.length > 0 && (
          <button
            onClick={() => setPreview(videos[0])}
            className="w-[44px] h-[44px] lg:w-10 lg:h-10 shrink-0 rounded border border-line-strong bg-slate-900 text-white flex items-center justify-center hover:border-accent"
            title="Play video"
          >
            <Video className="w-4 h-4" />
          </button>
        )}
        {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
      </div>
    )
  }

  return (
    <div className={`border border-line rounded-md bg-white overflow-hidden ${className}`}>
      <div className="flex items-center gap-1.5 px-3 py-2 bg-slate-50 border-b border-line text-xs font-medium text-ink">
        <ShieldCheck className="w-4 h-4 text-success" />
        Live camera evidence
      </div>

      <div className={`grid gap-px bg-line ${media.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {[...photos, ...videos].map((file) => (
          <div key={file.id} className="bg-white">
            <div className="bg-ink flex items-center justify-center h-64">
              {file.kind === 'PHOTO' ? (
                <img
                  src={mediaUrl(file.url)}
                  alt="Evidence photo"
                  className="max-h-64 w-full object-contain cursor-zoom-in"
                  onClick={() => setPreview(file)}
                />
              ) : (
                <video src={mediaUrl(file.url)} controls preload="metadata" className="max-h-64 w-full" />
              )}
            </div>
            <div className="p-3 grid grid-cols-2 gap-2 text-xs">
              <Meta label={file.kind === 'PHOTO' ? 'Photo captured' : 'Video captured'} value={formatDateTime(file.capturedAt)} />
              <Meta
                label="Size"
                value={`${formatBytes(file.sizeBytes)}${file.durationSeconds != null ? ` · ${Math.round(file.durationSeconds)} s` : ''}`}
              />
              <Meta label="SHA-256" value={`${file.sha256.slice(0, 16)}…`} mono title={file.sha256} />
              <Meta label="Uploaded" value={formatDateTime(file.createdAt)} />
            </div>
          </div>
        ))}
      </div>

      {(workerName || deviceInfo) && (
        <div className="px-3 py-2 border-t border-line grid grid-cols-2 gap-2 text-xs">
          {workerName && <Meta label="Captured by" value={workerName} />}
          {deviceInfo && <Meta label="Device" value={deviceInfo} />}
        </div>
      )}

      {preview && <PreviewModal file={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

const Meta: React.FC<{ label: string; value: string; mono?: boolean; title?: string }> = ({ label, value, mono, title }) => (
  <div className="min-w-0">
    <div className="text-ink-muted text-[11px]">{label}</div>
    <div className={`font-medium text-ink truncate mt-0.5 ${mono ? 'font-mono' : ''}`} title={title ?? value}>
      {value}
    </div>
  </div>
)

const PreviewModal: React.FC<{ file: MediaFile; onClose: () => void }> = ({ file, onClose }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4" onClick={onClose}>
    <div className="relative max-w-5xl w-full" onClick={(e) => e.stopPropagation()}>
      <button onClick={onClose} className="absolute -top-9 right-0 p-1 rounded text-slate-300 hover:text-white">
        <X className="w-5 h-5" />
      </button>
      {file.kind === 'PHOTO' ? (
        <img src={mediaUrl(file.url)} alt="Evidence" className="max-h-[85vh] w-full object-contain rounded" />
      ) : (
        <video src={mediaUrl(file.url)} controls autoPlay className="max-h-[85vh] w-full rounded bg-black" />
      )}
      <div className="mt-2 text-xs text-slate-300 font-mono">
        Captured {formatDateTime(file.capturedAt)} · SHA-256 {file.sha256}
      </div>
    </div>
  </div>
)
