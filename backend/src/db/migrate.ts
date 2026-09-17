import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { db, pool } from './client'

async function main() {
  await migrate(db, { migrationsFolder: './drizzle' })
  console.log('Migrations applied.')
  await pool.end()
}

main().catch(async (err) => {
  console.error(err)
  await pool.end()
  process.exit(1)
})
