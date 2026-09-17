import React, { useRef, useState } from 'react'
import { View, Text, KeyboardAvoidingView, Platform, ScrollView, TextInput } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { API_URL, ApiError, login } from '../services/api'
import { Profile } from '../types'
import { Button } from '../components/ui/Button'
import { FieldLabel } from '../components/ui/FieldLabel'
import { TextField } from '../components/ui/TextField'

interface Props {
  onSignedIn: (profile: Profile) => void
}

export const LoginScreen: React.FC<Props> = ({ onSignedIn }) => {
  const insets = useSafeAreaInsets()
  const [employeeId, setEmployeeId] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const passwordRef = useRef<TextInput>(null)

  const submit = async () => {
    if (!employeeId.trim() || !password) {
      setError('Enter your employee ID and password.')
      return
    }
    setLoading(true)
    setError(null)
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
        <View style={{ paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }}>
        <Text className="text-[14px] font-semibold uppercase tracking-[0.8px] text-ink-muted">Pouchwale Quality</Text>
        <Text className="mt-2 text-[34px] font-bold tracking-[-0.6px] text-ink">Sign in</Text>
        <Text className="mt-2 text-[17px] text-ink-secondary">Use the employee ID and password given by your supervisor.</Text>

        <View className="mt-10">
          <FieldLabel label="Employee ID" />
          <TextField
            placeholder="e.g. EMP-104"
            value={employeeId}
            onChangeText={setEmployeeId}
            autoCapitalize="characters"
            autoCorrect={false}
            returnKeyType="next"
            onSubmitEditing={() => passwordRef.current?.focus()}
          />
        </View>

        <View className="mt-6">
          <FieldLabel label="Password" />
          <TextField
            ref={passwordRef}
            placeholder="Password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </View>

        {error ? <Text className="mt-5 text-[16px] font-medium text-failed">{error}</Text> : null}

        <Button label="Sign In" onPress={submit} loading={loading} className="mt-8" />

        <Text className="mt-8 text-center text-[13px] text-ink-faint">Server: {API_URL}</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
