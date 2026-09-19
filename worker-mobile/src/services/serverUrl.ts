/**
 * "192.168.1.15:4000" -> "http://192.168.1.15:4000". Accepts an address with or without
 * http://, a trailing slash or /api. Returns null when it is not a usable server address.
 */
export function normalizeServerUrl(input: string): string | null {
  let text = input.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`
  // Parsed by hand: React Native's URL does not implement hostname/protocol on phones.
  const match = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::(\d{1,5}))?(\/[^\s?#]*)?\/?$/i.exec(text)
  if (!match) return null
  const [, scheme, host, port, rawPath = ''] = match
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null
  if (/^[.-]|[.-]$|\.\./.test(host)) return null
  const path = rawPath.replace(/\/+$/, '').replace(/\/api$/i, '')
  return `${scheme.toLowerCase()}://${host.toLowerCase()}${port ? `:${port}` : ''}${path}`
}
