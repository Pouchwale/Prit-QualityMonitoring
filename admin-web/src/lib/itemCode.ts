/** Same rule and message as the server (backend lib/validate.ts ITEM_CODE_PATTERN). */
export const ITEM_CODE_ERROR = 'Invalid Item Code. Only FGPO, FGLA, or FGSL followed by numbers are allowed. Example: FGPO123 (several: FGPO123, FGPO234).'

/** The Item Codes typed in one field, separated by commas, trimmed and upper-cased (empty parts dropped). */
export const splitItemCodes = (raw: string) => raw.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean)

/** The error for the typed Item Code(s), or null when empty or every one is valid (trimmed, any case). */
export function itemCodeError(raw: string): string | null {
  return splitItemCodes(raw).some((code) => !/^(FGPO|FGLA|FGSL)\d+$/.test(code)) ? ITEM_CODE_ERROR : null
}
