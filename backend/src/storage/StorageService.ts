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
  remove(path: string): Promise<void>
  /** A file on this server with the stored content, for processing (e.g. compressing a video). */
  localPath(path: string): string
}
