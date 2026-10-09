// npx tsx src/scripts/test-exception-details.ts — no database needed.
import assert from 'node:assert/strict'
import { exceptionDetailsError, isMachineReason } from '../lib/validate'

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
console.log('exception details: all checks passed')
