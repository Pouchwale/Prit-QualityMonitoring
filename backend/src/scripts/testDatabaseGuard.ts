import { config } from '../config'

/**
 * The test scripts create workers (password "password123"), schedules and checks in the database
 * they run against. They refuse to run unless that database is clearly a test one: its name contains
 * "test", "scratch" or "audit", or ALLOW_TEST_SCRIPTS=1 is set on purpose.
 */
export function assertTestDatabase() {
  const name = decodeURIComponent(new URL(config.databaseUrl).pathname.replace(/^\//, ''))
  if (process.env.ALLOW_TEST_SCRIPTS === '1' || /test|scratch|audit/i.test(name)) return
  console.error(`Refusing to run: database "${name}" does not look like a test database. Point DATABASE_URL at a test database, or set ALLOW_TEST_SCRIPTS=1.`)
  process.exit(1)
}
