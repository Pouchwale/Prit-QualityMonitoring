export type StorageCategory = 'quality-checks' | 'exceptions'

export interface StoredFile {
  /** Storage-relative path saved in the database. */
  path: string
}

/**
 * Storage abstraction so the local uploads/ folder can later be swapped for
 * a company file server, MinIO or S3 without touching business logic.
 */
export interface StorageService {
  /** Moves a temporary upload into permanent storage. */
  save(tempFilePath: string, options: { category: StorageCategory; extension: string }): Promise<StoredFile>
  /** URL path clients can use to fetch the file. */
  publicUrl(path: string): string
  remove(path: string): Promise<void>
}
