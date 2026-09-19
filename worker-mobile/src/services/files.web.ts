import { getApiUrl, ApiError, authHeaders, readError, withQuery, type Query } from './api'

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Browser: downloads a protected file with the signed-in user's token. */
export async function downloadAndShare(path: string, fileName: string, query?: Query) {
  const res = await fetch(`${getApiUrl()}${withQuery(path, query)}`, { headers: await authHeaders() })
  if (!res.ok) throw new ApiError(res.status, await readError(res))
  const disposition = res.headers.get('content-disposition') ?? ''
  const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? fileName
  saveBlob(await res.blob(), name)
  return name
}

export async function shareText(fileName: string, text: string, mimeType = 'text/csv') {
  saveBlob(new Blob(['\uFEFF', text], { type: mimeType }), fileName)
}
