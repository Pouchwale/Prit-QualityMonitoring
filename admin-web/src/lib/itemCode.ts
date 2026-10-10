/** Same rule and message as the server (backend lib/validate.ts ITEM_CODE_PATTERN). */
export const ITEM_CODE_ERROR = 'Invalid Item Code. Only FGPO, FGLA, or FGSL followed by numbers are allowed. Example: FGPO123.'

/** The error for a typed Item Code, or null when it is empty or valid (trimmed, any case). */
export function itemCodeError(raw: string): string | null {
  const code = raw.trim().toUpperCase()
  return code && !/^(FGPO|FGLA|FGSL)\d+$/.test(code) ? ITEM_CODE_ERROR : null
}
