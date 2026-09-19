import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dateKey } from '../lib/time'
import type { StorageService, StoredFile, StorageCategory } from './StorageService'

/** Stores files under <uploadDir>/<category>/<YYYY-MM-DD>/<uuid>.<ext> on the backend PC. */
export class LocalStorage implements StorageService {
  constructor(private rootDir: string) {}

  async save(tempFilePath: string, options: { category: StorageCategory; extension: string }): Promise<StoredFile> {
    const ext = options.extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'
    const relative = path.posix.join(options.category, dateKey(new Date()), `${randomUUID()}.${ext}`)
    const destination = path.join(this.rootDir, relative)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    try {
      await fs.rename(tempFilePath, destination)
    } catch {
      // Cross-device moves are not supported by rename.
      await fs.copyFile(tempFilePath, destination)
      await fs.unlink(tempFilePath)
    }
    return { path: relative }
  }

  async remove(relativePath: string): Promise<void> {
    await fs.rm(this.localPath(relativePath), { force: true })
  }

  localPath(relativePath: string): string {
    const full = path.resolve(this.rootDir, relativePath)
    if (!full.startsWith(path.resolve(this.rootDir) + path.sep)) throw new Error(`Invalid storage path: ${relativePath}`)
    return full
  }
}
