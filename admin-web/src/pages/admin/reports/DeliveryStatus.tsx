import React from 'react'
import { CheckCircle2, Clock, RotateCw, XCircle } from 'lucide-react'
import type { DeliveryStatus } from '../../../types'

const STYLE: Record<DeliveryStatus, { label: string; className: string; icon: React.ReactNode; title: string }> = {
  SENT: {
    label: 'Sent',
    className: 'bg-success-bg text-success ring-success-line',
    icon: <CheckCircle2 className="w-3 h-3" aria-hidden />,
    title: 'The mail server accepted the email. Whether it was received or read is not known.'
  },
  FAILED: { label: 'Failed', className: 'bg-missed-bg text-missed ring-missed-line', icon: <XCircle className="w-3 h-3" aria-hidden />, title: 'Not sent' },
  PENDING: { label: 'Pending', className: 'bg-subtle text-ink-secondary ring-line', icon: <Clock className="w-3 h-3" aria-hidden />, title: 'Waiting to be sent, or being sent now' },
  RETRYING: {
    label: 'Retrying',
    className: 'bg-due-bg text-due ring-due-line',
    icon: <RotateCw className="w-3 h-3" aria-hidden />,
    title: 'A temporary failure: it is sent again automatically'
  }
}

/** Sent / Failed / Pending / Retrying, as in the Delivery log and the failure popup. */
export const DeliveryStatusPill: React.FC<{ status: DeliveryStatus | string }> = ({ status }) => {
  const s = STYLE[(status === 'SUCCESS' ? 'SENT' : status) as DeliveryStatus] ?? STYLE.PENDING
  return (
    <span className={`inline-flex items-center gap-1 h-5 px-2 rounded-full ring-1 ring-inset text-[11px] font-semibold whitespace-nowrap ${s.className}`} title={s.title}>
      {s.icon}
      {s.label}
    </span>
  )
}
