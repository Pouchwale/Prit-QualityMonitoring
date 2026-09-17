import pg from 'pg'
import { config } from '../config'

/** Creates the database named in DATABASE_URL if it does not exist yet. */
async function main() {
  const url = new URL(config.databaseUrl)
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!/^[A-Za-z0-9_]+$/.test(dbName)) {
    throw new Error(`Unsupported database name "${dbName}". Use letters, digits and underscores.`)
  }

  url.pathname = '/postgres'
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])
    if (existing.rowCount) {
      console.log(`Database "${dbName}" already exists.`)
    } else {
      await client.query(`CREATE DATABASE "${dbName}"`)
      console.log(`Created database "${dbName}".`)
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
