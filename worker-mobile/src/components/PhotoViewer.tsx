import React from 'react'
import { Image, Modal, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from './ui/Icon'

/** A photo full screen on black; tap anywhere (or Close) to go back. Used by worker and staff screens. */
export const PhotoViewer: React.FC<{ uri: string | null; label?: string; onClose: () => void }> = ({ uri, label = 'Photo', onClose }) => {
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable className="flex-1 items-center justify-center bg-black" onPress={onClose} accessibilityRole="button" accessibilityLabel="Close photo">
        {uri ? <Image source={{ uri }} resizeMode="contain" className="h-full w-full" accessibilityLabel={label} /> : null}
      </Pressable>
      <View className="absolute right-2" style={{ top: insets.top + 4 }}>
        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close photo" className="h-12 w-12 items-center justify-center rounded-full active:opacity-60">
          <Icon name="close" size={26} color="white" />
        </Pressable>
      </View>
    </Modal>
  )
}
