import { config } from '../config'
import { LocalStorage } from './LocalStorage'
import type { StorageService } from './StorageService'

export const storage: StorageService = new LocalStorage(config.uploadDir)
