import React, { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { ApiError, DEFAULT_API_URL, getApiUrl, normalizeServerUrl, setServerUrl, testServer, usesCustomServer } from '../services/api'
import { Button } from './ui/Button'
import { FieldLabel } from './ui/FieldLabel'
import { Icon } from './ui/Icon'
import { TextField } from './ui/TextField'

interface Props {
  visible: boolean
  /** Shown above the field, e.g. why the app could not start. */
  problem?: string | null
  onClose: () => void
  /** The app now uses this server (already saved on the device). */
  onSaved: (url: string) => void
}

/**
 * Sign in -> Server settings: the address of the Quality Monitoring server. When the server's
 * IP address changes, the worker enters the new one here instead of installing a new app. The
 * address is checked (the server must answer) before it is saved, and kept after a restart.
 */
export const ServerSettingsSheet: React.FC<Props> = ({ visible, problem, onClose, onSaved }) => {
  const insets = useSafeAreaInsets()
  const [address, setAddress] = useState(getApiUrl())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)

  useEffect(() => {
    if (visible) {
      setAddress(getApiUrl())
      setError(null)
      setBusy(null)
    }
  }, [visible])

  const save = async () => {
    const url = normalizeServerUrl(address)
    if (!url) {
      setError('Enter the server address, for example http://192.168.1.15:4000')
      return
    }
    setBusy('save')
    setError(null)
    try {
      await testServer(url)
      await setServerUrl(url)
      onSaved(url)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect. Please try again.')
    } finally {
      setBusy(null)
    }
  }

  /** Back to the address the app was built with (not checked, so it always works offline too). */
  const reset = async () => {
    setBusy('reset')
    await setServerUrl(null)
    setBusy(null)
    onSaved(DEFAULT_API_URL)
  }

  const custom = usesCustomServer()

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable className="flex-1 bg-black/40" onPress={onClose} accessibilityLabel="Close server settings" />
        <View
          className="rounded-t-[24px] bg-canvas px-5 pt-5"
          style={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
          accessibilityViewIsModal
          aria-modal
          role="dialog"
          aria-label="Server settings"
        >
          <View className="flex-row items-center">
            <View className="h-11 w-11 items-center justify-center rounded-full bg-accent-soft">
              <Icon name="server-outline" size={22} color="accent" />
            </View>
            <View className="ml-3 flex-1">
              <Text className="text-[22px] font-bold leading-[28px] text-ink" accessibilityRole="header">
                Server settings
              </Text>
              <Text className="text-[14px] text-ink-muted" numberOfLines={1}>
                Now: {getApiUrl()}
                {custom ? ' (set on this phone)' : ''}
              </Text>
            </View>
          </View>

          {problem ? (
            <View className="mt-4 flex-row items-start rounded-xl bg-exception-bg px-3 py-2.5">
              <Icon name="cloud-offline-outline" size={18} color="exception" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-ink">{problem}</Text>
            </View>
          ) : null}

          <View className="mt-5">
            <FieldLabel label="Server address" />
            <TextField
              variant="outlined"
              value={address}
              onChangeText={(text) => {
                setAddress(text)
                setError(null)
              }}
              placeholder="http://192.168.1.15:4000"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={save}
              invalid={!!error}
              accessibilityLabel="Server address"
            />
            <Text className="mt-1.5 text-[13px] leading-[18px] text-ink-muted">
              The address of the PC running the Quality Monitoring server, with its port (usually 4000). Ask your supervisor if you do not know it.
            </Text>
          </View>

          {error ? (
            <View className="mt-4 flex-row items-start rounded-xl bg-missed-bg px-3 py-2.5" accessibilityLiveRegion="polite">
              <Icon name="alert-circle" size={18} color="missed" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-missed">{error}</Text>
            </View>
          ) : null}

          <View className="mt-5 gap-2.5">
            <Button label={busy === 'save' ? 'Connecting…' : 'Save & Connect'} icon="checkmark-circle-outline" onPress={save} loading={busy === 'save'} disabled={!!busy} />
            {custom ? (
              <Button label="Use the built-in address" variant="tinted" onPress={reset} loading={busy === 'reset'} disabled={!!busy} />
            ) : null}
            <Button label="Cancel" variant="plain" onPress={onClose} disabled={busy === 'save'} />
          </View>
          {custom ? (
            <Text className="mt-2 text-center text-[13px] text-ink-muted" numberOfLines={1}>
              Built-in: {DEFAULT_API_URL}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
