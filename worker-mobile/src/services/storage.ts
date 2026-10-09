import * as SecureStore from 'expo-secure-store'
import { Directory, File, Paths } from 'expo-file-system'

/**
 * Sign-in tokens. On phones they live in the device keychain/keystore.
 * The web app uses storage.web.ts instead.
 */
export const tokenStorage = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  remove: (key: string) => SecureStore.deleteItemAsync(key)
}

/**
 * Check forms the worker has started but not sent yet (typed readings and Not Applicable choices,
 * never photos or videos), one small file per check in the app's own folder. The keychain above
 * is not used: it only holds short values. Nothing here ever stops the form from working.
 */
const draftsDir = () => new Directory(Paths.document, 'check-drafts')
const draftFile = (id: string) => new File(draftsDir(), `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`)

export const draftStorage = {
  get: async (id: string): Promise<string | null> => {
    try {
      const file = draftFile(id)
      return file.exists ? await file.text() : null
    } catch {
      return null
    }
  },
  set: async (id: string, value: string) => {
    try {
      const dir = draftsDir()
      if (!dir.exists) dir.create({ intermediates: true })
      const file = draftFile(id)
      if (!file.exists) file.create()
      file.write(value)
    } catch {
      // Only the draft is lost; the form keeps working.
    }
  },
  remove: async (id: string) => {
    try {
      const file = draftFile(id)
      if (file.exists) file.delete()
    } catch {
      // Removed with the others at sign out.
    }
  },
  /** At sign out: the next person on this phone starts with empty forms. */
  clear: async () => {
    try {
      const dir = draftsDir()
      if (dir.exists) dir.delete()
    } catch {
      // Nothing else to do.
    }
  }
}
