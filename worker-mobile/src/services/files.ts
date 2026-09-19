import { Directory, File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { getApiUrl, ApiError, authHeaders, withQuery, type Query } from './api'

/**
 * Downloads a protected file (report PDF, CSV) and opens the share sheet so it can be saved or
 * sent. The web app uses files.web.ts (browser download).
 */
export async function downloadAndShare(path: string, fileName: string, query?: Query, mimeType?: string) {
  const headers = await authHeaders()
  const dir = new Directory(Paths.cache, 'downloads')
  if (!dir.exists) dir.create({ intermediates: true })
  const target = new File(dir, fileName.replace(/[\/:*?"<>|]/g, '_'))
  if (target.exists) target.delete()
  let file: File
  try {
    file = await File.downloadFileAsync(`${getApiUrl()}${withQuery(path, query)}`, target, { headers, idempotent: true })
  } catch (err) {
    throw new ApiError(0, err instanceof Error ? err.message : 'Download failed')
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName })
  return file.uri
}

/** Writes text (e.g. a CSV export) to a file and shares it. */
export async function shareText(fileName: string, text: string, mimeType = 'text/csv') {
  const dir = new Directory(Paths.cache, 'downloads')
  if (!dir.exists) dir.create({ intermediates: true })
  const file = new File(dir, fileName)
  if (file.exists) file.delete()
  file.create()
  file.write(text)
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: fileName })
}
