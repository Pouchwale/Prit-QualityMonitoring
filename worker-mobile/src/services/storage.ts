import * as SecureStore from 'expo-secure-store'

/**
 * Sign-in tokens. On phones they live in the device keychain/keystore.
 * The web app uses storage.web.ts instead.
 */
export const tokenStorage = {
  get: (key: string) => SecureStore.getItemAsync(key),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  remove: (key: string) => SecureStore.deleteItemAsync(key)
}
