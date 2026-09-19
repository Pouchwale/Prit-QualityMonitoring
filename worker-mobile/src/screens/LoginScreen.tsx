import React, { useRef, useState } from 'react'
import { View, Text, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { canChangeServer, getApiUrl, ApiError, login } from '../services/api'
import { Profile } from '../types'
import { Button } from '../components/ui/Button'
import { FieldLabel } from '../components/ui/FieldLabel'
import { TextField } from '../components/ui/TextField'
import { Icon } from '../components/ui/Icon'
import { ServerSettingsSheet } from '../components/ServerSettingsSheet'

interface Props {
  onSignedIn: (profile: Profile) => void
}

export const LoginScreen: React.FC<Props> = ({ onSignedIn }) => {
  const insets = useSafeAreaInsets()
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [serverOpen, setServerOpen] = useState(false)
  /** "Connected to …" after the server address was changed. */
  const [notice, setNotice] = useState<string | null>(null)
  const [server, setServer] = useState(getApiUrl())
  const passwordRef = useRef<TextInput>(null)

  const submit = async () => {
    if (!employeeId.trim() || !password) {
      setError('Enter your employee ID and password.')
      return
    }
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      onSignedIn(await login(employeeId.trim(), password))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <KeyboardAvoidingView className="flex-1 bg-canvas" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        className="flex-1"
        contentContainerClassName="flex-grow justify-center px-6"
        keyboardShouldPersistTaps="handled"
      >
        <View className="w-full max-w-[440px] self-center" style={{ paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 }}>
          <Image
            source={require('../../assets/icon.png')}
            accessibilityIgnoresInvertColors
            accessibilityLabel="Pouchwale Quality"
            style={{ width: 72, height: 72, borderRadius: 18, marginBottom: 24 }}
          />
          <Text className="text-[15px] font-medium text-ink-muted">Pouchwale Quality</Text>
          <Text className="mt-0.5 text-[34px] font-bold leading-[40px] tracking-[-0.6px] text-ink" accessibilityRole="header">
            Sign in
          </Text>
          <Text className="mt-2 text-[17px] leading-[22px] text-ink-secondary">
            Use the employee ID and password given by your supervisor.
          </Text>

          <View className="mt-9 gap-5">
            <View>
              <FieldLabel label="Employee ID" />
              <TextField
                variant="outlined"
                placeholder="e.g. EMP-104"
                value={employeeId}
                onChangeText={(text) => {
                  setEmployeeId(text)
                  setError(null)
                }}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="username"
                returnKeyType="next"
                accessibilityLabel="Employee ID"
                onSubmitEditing={() => passwordRef.current?.focus()}
              />
            </View>

            <View>
              <FieldLabel label="Password" />
              <TextField
                ref={passwordRef}
                variant="outlined"
                placeholder="Password"
                value={password}
                onChangeText={(text) => {
                  setPassword(text)
                  setError(null)
                }}
                secureTextEntry
                autoComplete="current-password"
                returnKeyType="go"
                accessibilityLabel="Password"
                onSubmitEditing={submit}
              />
            </View>
          </View>

          {error ? (
            <View className="mt-5 flex-row items-start rounded-xl bg-missed-bg px-3 py-2.5" accessibilityLiveRegion="polite">
              <Icon name="alert-circle" size={18} color="missed" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-missed">{error}</Text>
            </View>
          ) : null}

          <Button label="Sign In" onPress={submit} loading={loading} className="mt-8" />

          {notice ? (
            <View className="mt-5 flex-row items-start rounded-xl bg-success-bg px-3 py-2.5" accessibilityLiveRegion="polite">
              <Icon name="checkmark-circle" size={18} color="success" />
              <Text className="ml-2 flex-1 text-[15px] leading-[20px] text-success">{notice}</Text>
            </View>
          ) : null}

          {/* The server's address can change (new IP): the phone app sets it here, no new app needed. */}
          {canChangeServer ? (
            <>
              <Pressable
                onPress={() => setServerOpen(true)}
                className="mt-8 min-h-[48px] max-w-full items-center justify-center self-center rounded-xl px-3 py-1.5 active:opacity-60"
                accessibilityRole="button"
                accessibilityLabel={`Server settings. Server: ${server}`}
              >
                <View className="max-w-full flex-row items-center">
                  <Icon name="server-outline" size={15} color="muted" />
                  <Text className="ml-1.5 shrink text-[13px] text-ink-muted" numberOfLines={1}>
                    Server: {server}
                  </Text>
                </View>
                <Text className="mt-0.5 text-[14px] font-semibold text-accent">Server settings</Text>
              </Pressable>
              <ServerSettingsSheet
                visible={serverOpen}
                onClose={() => setServerOpen(false)}
                onSaved={(url) => {
                  setServerOpen(false)
                  setServer(url)
                  setError(null)
                  setNotice(`Connected to ${url}. You can sign in.`)
                }}
              />
            </>
          ) : (
            <Text className="mt-8 text-center text-[13px] text-ink-muted">Server: {server}</Text>
          )}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
