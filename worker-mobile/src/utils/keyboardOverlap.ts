/**
 * How much of the app window the soft keyboard hides, in dp.
 *
 * `keyboardScreenY` is the top edge of the keyboard on screen, as the keyboard events report it.
 * A device that resizes the app window itself reports the keyboard just below the smaller window,
 * so the overlap is 0 and nothing is padded twice.
 */
export const keyboardOverlap = (windowHeight: number, keyboardScreenY: number) => Math.max(0, Math.round(windowHeight - keyboardScreenY))
