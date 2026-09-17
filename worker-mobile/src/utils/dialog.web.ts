export interface DialogButton {
  text: string
  style?: 'default' | 'cancel' | 'destructive'
  onPress?: () => void
}

/**
 * React Native's Alert does nothing in a browser, so the web app uses the browser's own
 * dialogs: a Cancel/OK choice becomes confirm(), anything else becomes alert().
 */
export function showDialog(title: string, message?: string, buttons: DialogButton[] = []) {
  const text = message ? `${title}\n\n${message}` : title
  const cancel = buttons.find((b) => b.style === 'cancel')
  const action = buttons.find((b) => b.style !== 'cancel')

  if (cancel && action) {
    if (window.confirm(text)) action.onPress?.()
    else cancel.onPress?.()
    return
  }
  window.alert(text)
  ;(action ?? cancel)?.onPress?.()
}
