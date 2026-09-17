import React, { useState } from 'react'
import { Building2, Camera, Server } from 'lucide-react'
import type { Settings } from '../../types'
import { API_URL, api, errorText } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { useCanManage } from '../../lib/auth'
import { Section } from '../../components/common/Section'
import { Button } from '../../components/common/Button'
import { Field, FormError, TextInput } from '../../components/common/Form'
import { PageHeader } from '../../components/common/PageHeader'
import { useToast } from '../../components/common/Toast'

interface SettingsPageProps {
  onPlantNameChange: (name: string) => void
}

const plantNameOf = (settings: Settings | null) => {
  const plant = settings?.plant
  if (plant && typeof plant === 'object' && 'name' in plant && typeof plant.name === 'string') return plant.name
  return ''
}


const EVIDENCE_RULES: { title: string; detail: string }[] = [
  { title: 'Live capture only', detail: 'Photos and videos must be taken with the camera inside the worker app. Picking files from the gallery is not allowed.' },
  { title: 'Fresh evidence', detail: 'The server rejects files captured more than 30 minutes before the check is submitted.' },
  { title: 'No re-used files', detail: 'Each file is fingerprinted (SHA-256). A file that was already uploaded for another check is rejected.' },
  { title: 'Video length', detail: 'Videos can be at most 60 seconds long.' },
  { title: 'Where it is configured', detail: 'Whether a photo or video is required is set per check type on the Check Types page.' }
]

export const SettingsPage: React.FC<SettingsPageProps> = ({ onPlantNameChange }) => {
  const canEdit = useCanManage('settings')
  const notify = useToast()
  const settingsApi = useApi<Settings>('/api/settings')

  /** null until the user edits the field, so the saved value shows once loaded. */
  const [plantDraft, setPlantDraft] = useState<string | null>(null)
  const [plantError, setPlantError] = useState<string | null>(null)
  const [savingPlant, setSavingPlant] = useState(false)


  const savedPlantName = plantNameOf(settingsApi.data)
  const plantName = plantDraft ?? savedPlantName

  const savePlant = async (e: React.SyntheticEvent) => {
    e.preventDefault()
    const name = plantName.trim()
    if (name.length > 120) return setPlantError('Plant name must be 120 characters or fewer')
    setSavingPlant(true)
    setPlantError(null)
    try {
      // An empty name clears the setting, so no plant line is shown anywhere.
      await api.put('/api/settings', { plant: name ? { name } : null })
      onPlantNameChange(name)
      notify('success', 'Plant profile saved', name || 'No plant name is shown')
      await settingsApi.reload()
      setPlantDraft(null)
    } catch (err) {
      setPlantError(errorText(err))
    } finally {
      setSavingPlant(false)
    }
  }

  const plantDirty = plantName.trim() !== savedPlantName

  return (
    <div className="space-y-4 max-w-3xl">
      <PageHeader title="Settings" description="Plant profile and evidence rules" />

      <Section icon={<Building2 className="w-4 h-4" />} title="Plant profile" description="Shown in the console header and on reports">
        <form onSubmit={savePlant} className="space-y-3">
          {settingsApi.error && <FormError message={`Could not load settings: ${settingsApi.error}`} />}
          <FormError message={plantError} />
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <Field label="Plant name" className="flex-1" hint={canEdit ? undefined : 'You can view the plant profile but not change it'}>
              <TextInput
                value={plantName}
                onChange={(e) => setPlantDraft(e.target.value)}
                placeholder={settingsApi.loading ? 'Loading…' : 'Leave empty if not needed'}
                maxLength={120}
                disabled={!canEdit || settingsApi.loading}
              />
            </Field>
            {canEdit && (
              <Button size="field" variant="primary" type="submit" loading={savingPlant} disabled={!plantDirty || settingsApi.loading} className="sm:mb-0">
                Save
              </Button>
            )}
          </div>
        </form>
      </Section>

      <Section icon={<Camera className="w-4 h-4" />} title="Evidence rules" description="Enforced by the worker app and the server. These rules are fixed and cannot be changed here.">
        <ul className="divide-y divide-line border border-line rounded">
          {EVIDENCE_RULES.map((r) => (
            <li key={r.title} className="px-3 py-2 flex flex-col sm:flex-row sm:gap-4 text-xs">
              <span className="sm:w-44 shrink-0 font-semibold text-ink">{r.title}</span>
              <span className="text-ink-secondary">{r.detail}</span>
            </li>
          ))}
        </ul>
      </Section>


      <Section icon={<Server className="w-4 h-4" />} title="Connection" description="For troubleshooting">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-ink-muted">API server</dt>
          <dd className="font-mono text-ink break-all">{API_URL}</dd>
          <dt className="text-ink-muted">Status</dt>
          <dd className={settingsApi.error ? 'text-failed' : settingsApi.loading ? 'text-ink-muted' : 'text-success'}>
            {settingsApi.error ?? (settingsApi.loading ? 'Checking…' : 'Connected')}
          </dd>
        </dl>
        <p className="text-[11px] text-ink-muted mt-2">
          Set <span className="font-mono">VITE_API_URL</span> when building the console to point it at a different server.
        </p>
      </Section>
    </div>
  )
}
