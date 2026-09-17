import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { config } from '../config'
import * as schema from './schema'

export const pool = new pg.Pool({ connectionString: config.databaseUrl })

export const db = drizzle(pool, { schema })

export type Database = typeof db
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
