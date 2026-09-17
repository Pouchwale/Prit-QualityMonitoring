import { pool } from '../db/client'
import { prepareChecks } from '../services/checkGenerator'
import { notifyDueChecks } from '../services/notifications'

/** Runs one scheduler pass by hand: `npm run notify:once`. Useful for testing alerts. */
async function main() {
  await prepareChecks([new Date()])
  const result = await notifyDueChecks()
  console.log(JSON.stringify(result))
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
