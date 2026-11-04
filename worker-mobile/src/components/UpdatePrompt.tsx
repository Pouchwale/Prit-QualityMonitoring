import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, AppState, BackHandler, Modal, Platform, Pressable, Text, View } from 'react-native'
import * as Updates from 'expo-updates'
import { Icon } from './ui/Icon'

/** While the app is open, look for a new update this often (and whenever it comes back to the front). */
const CHECK_EVERY_MS = 5 * 60_000

/**
 * A new app update (EAS Update, published from the PC) must reach every phone at once, not on the
 * next cold start. When one is available, or was already downloaded in the background, this popup
 * covers the app with a single UPDATE button: no Cancel, Android Back and the backdrop do nothing.
 * UPDATE downloads it (if needed) and restarts the app on it. Phones only: the web app always
 * loads the latest build; development builds have no updates.
 */
export const UpdatePrompt: React.FC = () => {
  const supported = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled
  const { isUpdateAvailable, isUpdatePending } = Updates.useUpdates()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const checking = useRef(false)

  // Asks the update server; the result updates isUpdateAvailable above.
  const check = useCallback(async () => {
    if (!supported || checking.current) return
    checking.current = true
    try {
      await Updates.checkForUpdateAsync()
    } catch {
      // Offline or the update server is unreachable: asked again later.
    } finally {
      checking.current = false
    }
  }, [supported])

  useEffect(() => {
    if (!supported) return
    check()
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') check()
    }, CHECK_EVERY_MS)
    const sub = AppState.addEventListener('change', (state) => state === 'active' && check())
    return () => {
      clearInterval(timer)
      sub.remove()
    }
  }, [supported, check])

  const visible = supported && (isUpdateAvailable || isUpdatePending)

  // Android Back does nothing while the popup is shown: the update is not optional.
  useEffect(() => {
    if (!visible) return
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true)
    return () => sub.remove()
  }, [visible])

  const update = async () => {
    setBusy(true)
    setFailed(false)
    try {
      // Already downloaded in the background: restart on it straight away.
      if (!isUpdatePending) await Updates.fetchUpdateAsync()
      await Updates.reloadAsync()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  if (!visible) return null
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => undefined} statusBarTranslucent>
      <View className="flex-1 items-center justify-center bg-black/40 px-5">
        <View
          className="w-full max-w-[400px] rounded-[20px] bg-surface px-5 pb-4 pt-5"
          style={{ shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 24, shadowOffset: { width: 0, height: 8 }, elevation: 12 }}
          accessibilityViewIsModal
          aria-modal
          role="alertdialog"
          aria-label="Update available"
        >
          <View className="flex-row items-start">
            <View className="h-10 w-10 items-center justify-center rounded-full bg-accent-soft">
              <Icon name="cloud-download-outline" size={22} color="accent" />
            </View>
            <View className="ml-3 flex-1 pt-1.5">
              <Text className="text-[18px] font-semibold leading-[23px] text-ink" accessibilityRole="header">
                Update available
              </Text>
            </View>
          </View>
          <Text className="mt-3 text-[15px] leading-[21px] text-ink-secondary">
            {failed
              ? 'The update could not be downloaded. Check the internet connection and tap UPDATE again.'
              : 'A new version of the app is ready. Tap UPDATE to get the latest changes.'}
          </Text>
          <Pressable
            onPress={update}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Update"
            accessibilityState={{ disabled: busy, busy }}
            className={`mt-5 h-12 flex-row items-center justify-center rounded-xl bg-accent px-4 active:bg-accent-press ${busy ? 'opacity-80' : ''}`}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Icon name="refresh" size={18} color="white" />}
            <Text className="ml-2 text-[16px] font-semibold tracking-wide text-white">{busy ? 'Updating…' : 'UPDATE'}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}
