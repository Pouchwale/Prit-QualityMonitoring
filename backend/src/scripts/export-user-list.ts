import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import pdfmake from 'pdfmake'
import type { TDocumentDefinitions } from 'pdfmake/interfaces'
import { db, pool } from '../db/client'
import { users, departments } from '../db/schema'

/**
 * Writes a PDF list of every user: employee ID, name, role, department and status.
 * Run by hand: `npx tsx src/scripts/export-user-list.ts <output.pdf>`.
 * No password data is read or written; passwords are only shown one at a time to the Super
 * Admin in the panel (confirmed with their own password and audited).
 */
pdfmake.addFonts({ Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' } })

async function main() {
  const out = path.resolve(process.argv[2] ?? 'user-list.pdf')
  const rows = await db
    .select({ employeeId: users.employeeId, name: users.name, role: users.role, department: departments.name, active: users.isActive })
    .from(users)
    .leftJoin(departments, eq(users.departmentId, departments.id))
    .orderBy(users.role, users.name)

  const head = ['Employee ID', 'Name', 'Role', 'Department', 'Status'].map((text) => ({ text, bold: true, fillColor: '#F1F4F8' }))
  const body = rows.map((r) => [r.employeeId, r.name, r.role.replace('_', ' '), r.department ?? '-', r.active ? 'Active' : 'Disabled'])
  const doc: TDocumentDefinitions = {
    defaultStyle: { font: 'Helvetica', fontSize: 9.5 },
    pageMargins: [36, 40, 36, 40],
    footer: (page, pages) => ({ text: `Page ${page} of ${pages}`, alignment: 'center', fontSize: 8, color: '#566578' }),
    content: [
      { text: 'Quality Monitoring: user list', fontSize: 16, bold: true },
      { text: `${rows.length} users. Generated ${new Date().toLocaleString('en-IN')}. Passwords are not included.`, color: '#566578', margin: [0, 4, 0, 12] },
      { table: { headerRows: 1, widths: [80, '*', 80, 110, 55], body: [head, ...body] }, layout: 'lightHorizontalLines' }
    ]
  }
  const buf = (await pdfmake.createPdf(doc).getBuffer()) as unknown as Buffer
  fs.writeFileSync(out, buf)
  console.log(`Wrote ${rows.length} users to ${out}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => pool.end())
