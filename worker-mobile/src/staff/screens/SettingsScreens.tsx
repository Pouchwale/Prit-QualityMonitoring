import React, { useState } from 'react'
import { Platform, Text, View } from 'react-native'
import type { Settings } from '../types'
import { getApiUrl, api } from '../../services/api'
import { useStaff } from '../nav'
import { useQuery, errorText } from '../useQuery'
import { AccessDenied, FormError, FormSection, Icon, Input, PrimaryButton, Screen, type IconName, useToast } from '../ui'

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })

const plantNameOf = (settings: Settings | null) => {
  const plant = settings?.plant
  if (plant && typeof plant === 'object' && 'name' in plant && typeof plant.name === 'string') return plant.name
  return ''
}

const EVIDENCE_RULES: { title: string; detail: string; icon: IconName }[] = [
  { title: 'Live capture only', icon: 'camera-outline', detail: 'Photos and videos must be taken with the camera inside the worker app. Picking files from the gallery is not allowed.' },
  { title: 'Fresh evidence', icon: 'time-outline', detail: 'The server rejects files captured more than 30 minutes before the check is submitted.' },
  { title: 'No re-used files', icon: 'finger-print-outline', detail: 'Each file is fingerprinted (SHA-256). A file that was already uploaded for another check is rejected.' },
  { title: 'Video length', icon: 'videocam-outline', detail: 'Videos can be at most 60 seconds long.' },
  { title: 'Where it is configured', icon: 'list-outline', detail: 'Whether a photo or video is required is set per check type on the Check Types page.' }
]

/** Settings: plant profile, the fixed evidence rules and the server connection. */
export const SettingsScreen: React.FC<{ params: Record<string, never> }> = () => {
  const { can } = useStaff()
  const allowed = can('settings')
  const canEdit = can('settings', 'manage')
  const notify = useToast()
  const settingsApi = useQuery<Settings>(allowed ? '/api/settings' : null)

  /** null until the user edits the field, so the saved value shows once loaded. */
  const [plantDraft, setPlantDraft] = useState<string | null>(null)
  const [plantError, setPlantError] = useState<string | null>(null)
  const [savingPlant, setSavingPlant] = useState(false)

  const savedPlantName = plantNameOf(settingsApi.data)
  const plantName = plantDraft ?? savedPlantName
  const plantDirty = plantName.trim() !== savedPlantName

  if (!allowed) {
    return (
      <Screen title="Settings">
        <AccessDenied message="Ask an Admin for access to Settings." />
      </Screen>
    )
  }

  const savePlant = async () => {
    const name = plantName.trim()
    if (name.length > 120) return setPlantError('Plant name must be 120 characters or fewer')
    setSavingPlant(true)
    setPlantError(null)
    try {
      // An empty name clears the setting, so no plant line is shown anywhere.
      await api.put('/api/settings', { plant: name ? { name } : null })
      notify('success', 'Plant profile saved', name || 'No plant name is shown')
      await settingsApi.reload()
      setPlantDraft(null)
    } catch (err) {
      setPlantError(errorText(err))
    } finally {
      setSavingPlant(false)
    }
  }

  return (
    <Screen
      title="Settings"
      onRefresh={settingsApi.reload}
      refreshing={settingsApi.loading && !!settingsApi.data}
      footer={canEdit ? <PrimaryButton label="Save plant profile" onPress={savePlant} loading={savingPlant} disabled={!plantDirty || settingsApi.loading} /> : undefined}
    >
      {settingsApi.error ? <FormError message={`Could not load settings: ${settingsApi.error}`} /> : null}
      <FormError message={plantError} />

      <FormSection title="Plant profile" description="Shown in the console header and on reports">
        <Input
          label="Plant name"
          hint={canEdit ? undefined : 'You can view the plant profile but not change it'}
          value={plantName}
          onChangeText={setPlantDraft}
          placeholder={settingsApi.loading ? 'Loading…' : 'Leave empty if not needed'}
          maxLength={120}
          editable={canEdit && !settingsApi.loading}
        />
      </FormSection>

      <FormSection title="Evidence rules" description="Enforced by the worker app and the server. These rules are fixed and cannot be changed here.">
        {EVIDENCE_RULES.map((r) => (
          <View key={r.title} className="flex-row gap-3">
            <View className="pt-px">
              <Icon name={r.icon} size={20} color="muted" />
            </View>
            <View className="flex-1">
              <Text className="text-[15px] font-semibold leading-[20px] text-staff-ink">{r.title}</Text>
              <Text className="mt-0.5 text-[14px] leading-[19px] text-staff-ink2">{r.detail}</Text>
            </View>
          </View>
        ))}
      </FormSection>

      <FormSection title="Server" description="Connection details, for troubleshooting">
        <View>
          <Text className="mb-0.5 text-[12px] font-medium leading-[16px] text-staff-muted">API server</Text>
          <Text selectable className="text-[14px] leading-[19px] text-staff-ink" style={{ fontFamily: MONO }}>
            {getApiUrl()}
          </Text>
        </View>
        <View>
          <Text className="mb-0.5 text-[12px] font-medium leading-[16px] text-staff-muted">Status</Text>
          <View className="flex-row items-center gap-2">
            <View className={`h-2 w-2 rounded-full ${settingsApi.error ? 'bg-missed' : settingsApi.loading ? 'bg-staff-faint' : 'bg-success'}`} />
            <Text className={`flex-1 text-[15px] font-medium ${settingsApi.error ? 'text-missed' : settingsApi.loading ? 'text-staff-muted' : 'text-success'}`}>
              {settingsApi.error ?? (settingsApi.loading ? 'Checking…' : 'Connected')}
            </Text>
          </View>
        </View>
        <Text className="text-[13px] leading-[18px] text-staff-muted">
          To use another server (for example when its IP address changes), sign out and tap <Text className="font-semibold">Server settings</Text> on the sign-in screen. No new app is needed.
        </Text>
      </FormSection>
    </Screen>
  )
}

export const SETTINGS_SCREENS = {
  settings: SettingsScreen
}
