import React from 'react'
import { Card, CardHeader } from '../ui/Card'

/** Titled card used by the Settings and My Account pages. */
export const Section: React.FC<{ icon: React.ReactNode; title: string; description?: string; children: React.ReactNode }> = ({
  icon,
  title,
  description,
  children
}) => (
  <Card>
    <CardHeader icon={icon} title={title} subtitle={description} />
    <div className="p-4">{children}</div>
  </Card>
)
