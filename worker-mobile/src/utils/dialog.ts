import { Alert } from 'react-native'

export interface DialogButton {
  text: string
  style?: 'default' | 'cancel' | 'destructive'
  onPress?: () => void
}

/** A message or a choice. Native alert on phones; see dialog.web.ts for browsers. */
export function showDialog(title: string, message?: string, buttons?: DialogButton[]) {
  Alert.alert(title, message, buttons)
}
