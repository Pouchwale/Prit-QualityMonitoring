import React, { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Keyboard, Platform, ScrollView, TextInput, View, useWindowDimensions, type ScrollViewProps } from 'react-native'
import { keyboardOverlap } from './keyboardOverlap'

/**
 * Keyboard handling for the whole app, in one place.
 *
 * Android no longer resizes the app window when the keyboard opens (edge-to-edge is on from
 * Android 15 / Expo SDK 54), so the keyboard simply covers the bottom of the screen: the field
 * being typed in, the Save button, everything. `KeyboardAvoidingView` with the usual
 * `behavior: ios ? 'padding' : undefined` does nothing there.
 *
 * Instead every screen and sheet measures how much of the window the keyboard covers and leaves
 * exactly that much room, and the focused field is scrolled above it. It is plain JavaScript —
 * no native module — so it behaves the same on every Android phone and changes nothing on the
 * web build, where there is no soft keyboard and the overlap is always 0.
 */

export { keyboardOverlap } from './keyboardOverlap'

/**
 * The height the keyboard covers right now. 0 when it is closed, and also 0 on a device that
 * still resizes the window itself, because then the window is already the smaller one.
 */
export function useKeyboardOverlap(): number {
  const { height } = useWindowDimensions()
  const [overlap, setOverlap] = useState(0)

  useEffect(() => {
    // iOS reports the frame before it animates; Android only once the keyboard is there.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow'
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide'
    const show = Keyboard.addListener(showEvent, (e: { endCoordinates?: { screenY?: number } }) => {
      const screenY = e?.endCoordinates?.screenY
      setOverlap(typeof screenY === 'number' ? keyboardOverlap(height, screenY) : 0)
    })
    const hide = Keyboard.addListener(hideEvent, () => setOverlap(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [height])

  return overlap
}

/** The field the user is typing in, when the platform can tell us. */
function focusedInput(): { measureInWindow?: (cb: (x: number, y: number, w: number, h: number) => void) => void } | null {
  try {
    const state = (TextInput as unknown as { State?: { currentlyFocusedInput?: () => unknown } }).State
    return (state?.currentlyFocusedInput?.() as { measureInWindow?: never } | null) ?? null
  } catch {
    return null
  }
}

/** Closes the keyboard and drops the focus, e.g. when a sheet opens. */
export function dismissKeyboard() {
  try {
    const state = (TextInput as unknown as { State?: { blurTextInput?: (node: unknown) => void; currentlyFocusedInput?: () => unknown } }).State
    const node = state?.currentlyFocusedInput?.()
    if (node) state?.blurTextInput?.(node)
  } catch {
    /* best effort */
  }
  Keyboard.dismiss()
}

/**
 * Scrolls the field that has the focus above the keyboard. A scrolling container provides it;
 * the input components call it when they are focused, so any form gets the behaviour without
 * knowing anything about keyboards.
 */
const RevealContext = createContext<(() => void) | null>(null)

export const useRevealInput = () => useContext(RevealContext)

/** Margin kept between the field being typed in and the top of the keyboard. */
const REVEAL_MARGIN = 12

export interface KeyboardAwareScrollViewHandle {
  scrollTo: ScrollView['scrollTo']
  reveal: () => void
}

/**
 * A ScrollView that leaves room for the keyboard and keeps the focused field visible above it.
 * Use it wherever a screen or sheet contains something to type in.
 */
export const KeyboardAwareScrollView = forwardRef<KeyboardAwareScrollViewHandle, ScrollViewProps & { children: React.ReactNode; extraBottom?: number }>(
  ({ children, extraBottom = 0, contentContainerStyle, onScroll, ...props }, ref) => {
    const overlap = useKeyboardOverlap()
    const { height: windowHeight } = useWindowDimensions()
    const scroller = useRef<ScrollView>(null)
    const offset = useRef(0)

    const reveal = useCallback(() => {
      if (overlap <= 0) return
      const node = focusedInput()
      if (!node?.measureInWindow) return
      node.measureInWindow((_x, y, _w, h) => {
        const visibleBottom = windowHeight - overlap - REVEAL_MARGIN
        const hidden = y + h - visibleBottom
        if (hidden > 0) scroller.current?.scrollTo({ y: Math.max(0, offset.current + hidden), animated: true })
      })
    }, [overlap, windowHeight])

    // The keyboard has just opened (or grown): bring the field back into view.
    useEffect(() => {
      if (overlap > 0) {
        const timer = setTimeout(reveal, 60)
        return () => clearTimeout(timer)
      }
    }, [overlap, reveal])

    useImperativeHandle(ref, () => ({
      scrollTo: (...args: Parameters<ScrollView['scrollTo']>) => scroller.current?.scrollTo(...args),
      reveal
    }))

    const style = Array.isArray(contentContainerStyle) ? contentContainerStyle : [contentContainerStyle]

    return (
      <RevealContext.Provider value={reveal}>
        <ScrollView
          ref={scroller}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
          scrollEventThrottle={16}
          onScroll={(e) => {
            offset.current = e.nativeEvent.contentOffset.y
            onScroll?.(e)
          }}
          contentContainerStyle={[...style, { paddingBottom: overlap + extraBottom }]}
          {...props}
        >
          {children}
        </ScrollView>
      </RevealContext.Provider>
    )
  }
)

KeyboardAwareScrollView.displayName = 'KeyboardAwareScrollView'

/**
 * Keeps whatever is inside it above the keyboard: a bottom sheet, a dialog, a pinned footer.
 * Nothing is reserved while the keyboard is closed, so the layout is unchanged.
 */
export const KeyboardAvoider: React.FC<{ children: React.ReactNode; className?: string; style?: ScrollViewProps['style'] }> = ({ children, className, style }) => {
  const overlap = useKeyboardOverlap()
  return (
    <View className={className} style={[style, { paddingBottom: overlap }]}>
      {children}
    </View>
  )
}

/** Empty space as tall as the keyboard, for a list that has to scroll clear of it. */
export const KeyboardSpacer: React.FC<{ extra?: number }> = ({ extra = 0 }) => {
  const overlap = useKeyboardOverlap()
  return overlap > 0 ? <View style={{ height: overlap + extra }} /> : null
}
