// npx tsx src/scripts/test-exception-details.ts — no database needed.
import assert from 'node:assert/strict'
import { exceptionDetailsError, isMachineReason, ITEM_CODE_ERROR, validItemCode } from '../lib/validate'

const BOTH = 'Machine Name and PO No. / Item Code are required for an Exception.'
const MACHINE = 'Machine Name is required for an Exception.'
const PO = 'PO No. / Item Code is required for an Exception.'

assert.equal(exceptionDetailsError('m-1', 'PO-123'), null)
assert.equal(exceptionDetailsError(null, 'PO-123'), MACHINE)
assert.equal(exceptionDetailsError(undefined, 'PO-123'), MACHINE)
assert.equal(exceptionDetailsError('   ', 'PO-123'), MACHINE)
assert.equal(exceptionDetailsError('m-1', ''), PO)
assert.equal(exceptionDetailsError('m-1', '   '), PO)
assert.equal(exceptionDetailsError('m-1', null), PO)
assert.equal(exceptionDetailsError(null, undefined), BOTH)
assert.equal(exceptionDetailsError(' ', ' '), BOTH)
// Machine-related reasons need only the machine.
for (const r of ['Machine stopped', 'Machine under maintenance', 'Machine breakdown', 'Breakdown']) assert.ok(isMachineReason(r), r)
for (const r of ['Worker unavailable', 'Material unavailable', 'Production stopped', 'Other']) assert.ok(!isMachineReason(r), r)
assert.equal(exceptionDetailsError('m-1', '', true), null)
assert.equal(exceptionDetailsError('m-1', null, true), null)
assert.equal(exceptionDetailsError(null, 'PO-123', true), MACHINE)
assert.equal(exceptionDetailsError('  ', '', true), MACHINE)
// Item Code format (lib/validate.ts validItemCode).
for (const ok of ['FGPO123', 'FGPO1234', 'FGLA123', 'FGLA1234', 'FGSL123', 'FGSL1234']) assert.equal(validItemCode(ok), ok)
assert.equal(validItemCode('  fgpo123  '), 'FGPO123')
assert.equal(validItemCode(''), '')
assert.equal(validItemCode(null), '')
for (const bad of ['FGXX123', 'FGPOABC', 'FGPO', '123FGPO', 'FGPO 123', 'FGPO-123', 'FGSL@123', 'ABC123', 'FGPO - 7441', 'FGPO12A']) {
  assert.throws(() => validItemCode(bad), (e: Error) => e.message === ITEM_CODE_ERROR, bad)
}
console.log('exception details: all checks passed')
