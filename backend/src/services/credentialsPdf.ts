import pdfmake from 'pdfmake'
import type { TDocumentDefinitions } from 'pdfmake/interfaces'

pdfmake.addFonts({
  Helvetica: { normal: 'Helvetica', bold: 'Helvetica-Bold', italics: 'Helvetica-Oblique', bolditalics: 'Helvetica-BoldOblique' },
  Courier: { normal: 'Courier', bold: 'Courier-Bold', italics: 'Courier-Oblique', bolditalics: 'Courier-BoldOblique' }
})

export interface CredentialEntry {
  employeeId: string
  name: string
  role: string
  active: boolean
  /** Null when only the one-way fingerprint is stored (set before passwords could be viewed). */
  password: string | null
}

/** The credentials sheet (routes/users.ts "passwords/export"): employee ID and password per account. */
export async function renderCredentialsPdf(entries: CredentialEntry[], exportedBy: string): Promise<Buffer> {
  const head = ['Employee ID', 'Name', 'Role', 'Password'].map((text) => ({ text, bold: true, fillColor: '#F1F4F8' }))
  const body = entries.map((e) => [
    e.employeeId,
    e.active ? e.name : `${e.name} (disabled)`,
    e.role.replace('_', ' '),
    e.password !== null ? { text: e.password, font: 'Courier', bold: true } : { text: 'not available', italics: true, color: '#B45309' }
  ])
  const doc: TDocumentDefinitions = {
    defaultStyle: { font: 'Helvetica', fontSize: 10 },
    pageMargins: [36, 40, 36, 40],
    footer: (page, pages) => ({ text: `Confidential. Page ${page} of ${pages}`, alignment: 'center', fontSize: 8, color: '#566578' }),
    content: [
      { text: 'Quality Monitoring: user credentials', fontSize: 16, bold: true },
      { text: `Confidential. Exported by ${exportedBy} on ${new Date().toLocaleString('en-IN')}. Keep it private and destroy it after use.`, color: '#B91C1C', margin: [0, 4, 0, 4] },
      { text: '"Not available" means the password was set before passwords could be viewed. Set a new one in Edit, New password.', color: '#566578', fontSize: 9, margin: [0, 0, 0, 12] },
      { table: { headerRows: 1, widths: [85, '*', 70, 120], body: [head, ...body] }, layout: 'lightHorizontalLines' }
    ]
  }
  return (await pdfmake.createPdf(doc).getBuffer()) as unknown as Buffer
}
