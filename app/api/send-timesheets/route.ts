import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { jsPDF } from 'jspdf'
import QRCode from 'qrcode'
import fs from 'fs'
import path from 'path'

const resend = new Resend(process.env.RESEND_API_KEY)

// ─── Types ───────────────────────────────────────────────────
type RowData = {
  date: string
  start: string
  end: string
  hours: number
  night: number
  source: string
  rejected: boolean
  note: string | null
}

type SummaryData = {
  name: string
  email: string
  bank_account: string | null
  hourly_rate: number
  totalHours: number
  nightHours: number
  wage: number
  tips: number
  bonus: number
  consumption: number
  penalty: number
  payout: number
  rows: RowData[]
}

type RequestBody = {
  to: string
  month: string
  summaries: SummaryData[]
}

// ─── Helpers ─────────────────────────────────────────────────
function formatCZK(n: number): string {
  return n.toLocaleString('cs-CZ') + ' Kč'
}

function formatDate(s: string): string {
  const d = new Date(s + 'T00:00:00')
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' })
}

function czechAccountToIBAN(account: string): string {
  const clean = account.replace(/\s/g, '')
  const slashIdx = clean.indexOf('/')
  if (slashIdx === -1) return clean

  const bankCode = clean.substring(slashIdx + 1)
  const accPart = clean.substring(0, slashIdx)

  let prefix = '0'
  let baseNumber = accPart
  const dashIdx = accPart.indexOf('-')
  if (dashIdx !== -1) {
    prefix = accPart.substring(0, dashIdx)
    baseNumber = accPart.substring(dashIdx + 1)
  }

  const paddedPrefix = prefix.padStart(6, '0')
  const paddedBase = baseNumber.padStart(10, '0')
  const bban = bankCode + paddedPrefix + paddedBase

  const numStr = bban + '123500'
  let remainder = 0
  for (let i = 0; i < numStr.length; i++) {
    remainder = (remainder * 10 + parseInt(numStr[i])) % 97
  }
  const checkDigits = String(98 - remainder).padStart(2, '0')
  return `CZ${checkDigits}${bban}`
}

function generateSPD(account: string, amount: number, msg: string): string {
  const cappedAmount = Math.min(Math.max(amount, 0), 11400)
  const iban = czechAccountToIBAN(account)
  return [`SPD*1.0`, `ACC:${iban}`, `AM:${cappedAmount.toFixed(2)}`, `CC:CZK`, `MSG:${msg.substring(0, 60)}`].join('*')
}

// ─── Font loading ────────────────────────────────────────────
let cachedFontBase64: string | null = null

async function loadRobotoFont(): Promise<string> {
  if (cachedFontBase64) return cachedFontBase64

  // Try loading from local file first (if bundled)
  const localPath = path.join(process.cwd(), 'public', 'fonts', 'Roboto-Regular.ttf')
  if (fs.existsSync(localPath)) {
    cachedFontBase64 = fs.readFileSync(localPath).toString('base64')
    return cachedFontBase64
  }

  // Fetch from CDN
  const res = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/fonts/Roboto/Roboto-Regular.ttf')
  const buffer = Buffer.from(await res.arrayBuffer())
  cachedFontBase64 = buffer.toString('base64')
  return cachedFontBase64
}

async function loadRobotoBoldFont(): Promise<string> {
  const localPath = path.join(process.cwd(), 'public', 'fonts', 'Roboto-Bold.ttf')
  if (fs.existsSync(localPath)) {
    return fs.readFileSync(localPath).toString('base64')
  }
  const res = await fetch('https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/fonts/Roboto/Roboto-Medium.ttf')
  return Buffer.from(await res.arrayBuffer()).toString('base64')
}

// ─── QR code generation ─────────────────────────────────────
async function generateQRBase64(data: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(data, { width: 200, margin: 1 })
  return dataUrl // returns data:image/png;base64,...
}

// ─── PDF generation ──────────────────────────────────────────
async function generatePDF(month: string, summaries: SummaryData[]): Promise<Buffer> {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  // Load and register Roboto fonts for Czech diacritics
  const fontRegular = await loadRobotoFont()
  const fontBold = await loadRobotoBoldFont()

  doc.addFileToVFS('Roboto-Regular.ttf', fontRegular)
  doc.addFont('Roboto-Regular.ttf', 'Roboto', 'normal')
  doc.addFileToVFS('Roboto-Bold.ttf', fontBold)
  doc.addFont('Roboto-Bold.ttf', 'Roboto', 'bold')
  doc.setFont('Roboto', 'normal')

  let y = 20

  // Title
  doc.setFontSize(18)
  doc.setFont('Roboto', 'bold')
  doc.text(`Timesheety — ${month}`, 15, y)
  y += 5
  doc.setFontSize(8)
  doc.setFont('Roboto', 'normal')
  doc.setTextColor(150, 150, 150)
  doc.text(`Vygenerováno: ${new Date().toLocaleDateString('cs-CZ', { day: 'numeric', month: 'long', year: 'numeric' })}`, 15, y)
  doc.setTextColor(0, 0, 0)
  y += 10

  for (let idx = 0; idx < summaries.length; idx++) {
    const s = summaries[idx]

    // New page if not enough space
    if (y > 200) {
      doc.addPage()
      y = 20
    }

    // ── Worker header ──
    doc.setFillColor(255, 248, 240)
    doc.setDrawColor(230, 126, 34)
    doc.roundedRect(15, y - 6, 180, 11, 2, 2, 'FD')
    doc.setFontSize(13)
    doc.setFont('Roboto', 'bold')
    doc.text(s.name, 20, y + 1)
    y += 12

    // ── Info rows ──
    doc.setFontSize(9)
    doc.setFont('Roboto', 'normal')

    doc.text(`E-mail: ${s.email}`, 20, y)
    doc.text(`Účet: ${s.bank_account || '—'}`, 120, y)
    y += 5
    doc.text(`Odpracované hodiny: ${s.totalHours} h (z toho nočních: ${s.nightHours} h)`, 20, y)
    y += 5
    doc.text(`Hodinová sazba: ${s.hourly_rate} Kč/h`, 20, y)
    doc.text(`Mzda: ${formatCZK(s.wage)}`, 120, y)
    y += 5
    doc.text(`Dýška: ${formatCZK(s.tips)}`, 20, y)

    const extras: string[] = []
    if (s.bonus > 0) extras.push(`Odměna: +${formatCZK(s.bonus)}`)
    if (s.consumption > 0) extras.push(`Spotřeba: -${formatCZK(s.consumption)}`)
    if (s.penalty > 0) extras.push(`Pokuta: -${formatCZK(s.penalty)}`)
    if (extras.length > 0) {
      doc.text(extras.join('   |   '), 120, y)
    }
    y += 8

    // ── Payout box ──
    doc.setFillColor(39, 174, 96)
    doc.roundedRect(15, y - 5, 85, 10, 2, 2, 'F')
    doc.setFontSize(12)
    doc.setFont('Roboto', 'bold')
    doc.setTextColor(255, 255, 255)
    doc.text(`K výplatě: ${formatCZK(s.payout)}`, 20, y + 2)
    doc.setTextColor(0, 0, 0)

    if (s.payout > 11400) {
      doc.setFontSize(8)
      doc.setFont('Roboto', 'normal')
      doc.setTextColor(200, 0, 0)
      doc.text(`QR max 11 400 Kč, doplatek ${formatCZK(s.payout - 11400)} zvlášť`, 105, y + 2)
      doc.setTextColor(0, 0, 0)
    }
    y += 14

    // ── QR code ──
    if (s.bank_account) {
      const monthWord = month.split(' ')[0] || month
      const spdData = generateSPD(s.bank_account, s.payout, `Prosecco ${monthWord}`)
      const qrDataUrl = await generateQRBase64(spdData)

      // Check space for QR
      if (y + 45 > 280) {
        doc.addPage()
        y = 20
      }

      doc.setFontSize(9)
      doc.setFont('Roboto', 'bold')
      doc.text('QR platba:', 20, y)
      y += 2

      doc.addImage(qrDataUrl, 'PNG', 20, y, 35, 35)

      doc.setFontSize(8)
      doc.setFont('Roboto', 'normal')
      doc.text(`Částka: ${formatCZK(Math.min(s.payout, 11400))}`, 60, y + 8)
      doc.text(`Účet: ${s.bank_account}`, 60, y + 13)
      doc.text(`IBAN: ${czechAccountToIBAN(s.bank_account)}`, 60, y + 18)
      doc.text(`Zpráva: Prosecco ${monthWord}`, 60, y + 23)

      y += 40
    }

    // ── Timesheet table ──
    if (s.rows.length > 0) {
      if (y + 20 > 275) {
        doc.addPage()
        y = 20
      }

      doc.setFontSize(9)
      doc.setFont('Roboto', 'bold')
      doc.text('Vykázané směny:', 20, y)
      y += 5

      // Table header
      doc.setFontSize(7)
      doc.setFont('Roboto', 'bold')
      doc.setFillColor(245, 245, 245)
      doc.rect(15, y - 4, 180, 7, 'F')

      const cols = [
        { x: 17, label: 'Datum' },
        { x: 45, label: 'Od' },
        { x: 62, label: 'Do' },
        { x: 79, label: 'Hodiny' },
        { x: 99, label: 'Noční' },
        { x: 117, label: 'Zdroj' },
        { x: 140, label: 'Poznámka' },
      ]
      cols.forEach(c => doc.text(c.label, c.x, y))
      y += 5

      doc.setFont('Roboto', 'normal')
      doc.setFontSize(7)

      s.rows.forEach(row => {
        if (y > 278) {
          doc.addPage()
          y = 20
        }

        const textColor = row.rejected ? [180, 180, 180] : [0, 0, 0]
        doc.setTextColor(textColor[0], textColor[1], textColor[2])

        doc.text(formatDate(row.date), 17, y)
        doc.text(String(row.start || ''), 45, y)
        doc.text(String(row.end || ''), 62, y)
        doc.text(Number(row.hours || 0).toFixed(1), 79, y)
        doc.text(Number(row.night || 0).toFixed(1), 99, y)
        doc.text(row.source || '', 117, y)
        if (row.note) doc.text(row.note.substring(0, 35), 140, y)

        if (row.rejected) {
          doc.setDrawColor(180, 180, 180)
          doc.line(15, y - 1, 193, y - 1)
        }

        doc.setTextColor(0, 0, 0)
        y += 4.5
      })
    }

    y += 8

    // Separator
    if (idx < summaries.length - 1) {
      doc.setDrawColor(220, 220, 220)
      doc.setLineWidth(0.3)
      doc.line(15, y - 3, 195, y - 3)
      doc.setLineWidth(0.2)
      y += 5
    }
  }

  // Footer on last page
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFontSize(7)
    doc.setFont('Roboto', 'normal')
    doc.setTextColor(180, 180, 180)
    doc.text(`Saluti — strana ${i}/${pageCount}`, 15, 290)
    doc.setTextColor(0, 0, 0)
  }

  const arrayBuffer = doc.output('arraybuffer')
  return Buffer.from(arrayBuffer)
}

// ─── API handler ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body: RequestBody = await req.json()
    const { to, month, summaries } = body

    if (!to || !summaries || summaries.length === 0) {
      return NextResponse.json({ error: 'Chybí data' }, { status: 400 })
    }

    // Generate PDF with QR codes
    const pdfBuffer = await generatePDF(month, summaries)
    const pdfBase64 = pdfBuffer.toString('base64')

    // Build email HTML summary
    const htmlRows = summaries.map(s => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${s.name}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${s.totalHours} h</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${s.hourly_rate} Kč/h</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${formatCZK(s.wage)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${formatCZK(s.tips)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:700;color:#e67e22">${formatCZK(s.payout)}</td>
      </tr>
    `).join('')

    const totalPayout = summaries.reduce((sum, s) => sum + s.payout, 0)

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:650px;margin:0 auto;color:#333">
        <h2 style="color:#222;margin-bottom:4px">Timesheety — ${month}</h2>
        <p style="color:#888;font-size:13px;margin-top:0">Schválené výkazy za ${month}. Detaily včetně QR kódů pro platbu v příloze (PDF).</p>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin:20px 0">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px 12px;text-align:left">Jméno</th>
              <th style="padding:8px 12px;text-align:left">Hodiny</th>
              <th style="padding:8px 12px;text-align:left">Sazba</th>
              <th style="padding:8px 12px;text-align:left">Mzda</th>
              <th style="padding:8px 12px;text-align:left">Dýška</th>
              <th style="padding:8px 12px;text-align:left">K výplatě</th>
            </tr>
          </thead>
          <tbody>${htmlRows}</tbody>
          <tfoot>
            <tr style="background:#fff8f0">
              <td colspan="5" style="padding:10px 12px;font-weight:700">Celkem</td>
              <td style="padding:10px 12px;font-weight:700;color:#e67e22;font-size:15px">${formatCZK(totalPayout)}</td>
            </tr>
          </tfoot>
        </table>
        <p style="color:#bbb;font-size:11px;margin-top:30px">Saluti — automaticky generovaný e-mail</p>
      </div>
    `

    const safeMonth = month.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_čďěňřšťžůúýáéíóČĎĚŇŘŠŤŽŮÚÝÁÉÍÓ]/g, '')

    const { data, error } = await resend.emails.send({
      from: 'Saluti <onboarding@resend.dev>',
      to: [to],
      subject: `Timesheety — ${month}`,
      html,
      attachments: [
        {
          filename: `timesheety_${safeMonth}.pdf`,
          content: pdfBase64,
          contentType: 'application/pdf',
        },
      ],
    })

    if (error) {
      console.error('Resend error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, id: data?.id })
  } catch (err: any) {
    console.error('API error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}