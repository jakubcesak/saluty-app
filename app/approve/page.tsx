'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '../../lib/supabase'

// ─── Types ───────────────────────────────────────────────────
type Worker = {
  id: string
  name: string
  email: string
  hourly_rate: number
  bank_account: string | null
}

type MonthSummary = {
  worker: Worker
  totalHours: number
  nightHours: number
  wage: number
  tips: number
  bonus: number
  consumption: number
  penalty: number
  payout: number
  status: string
  timesheetIds: string[]
}

type TimesheetRow = {
  id: string
  work_date: string
  actual_start: string
  actual_end: string
  hours_worked: number
  night_hours: number
  source: string
  status: string
  rejected_at: string | null
  rejected_by: string | null
  added_by_admin: string | null
  admin_note: string | null
}

type Adjustments = {
  tips: string
  bonus: string
  consumption: string
  penalty: string
}

// ─── Helpers ─────────────────────────────────────────────────
function monthLabel(d: Date): string {
  return d.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })
}

function monthDbValue(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

function formatDate(s: string): string {
  const d = new Date(s + 'T00:00:00')
  return d.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' })
}

function formatCZK(n: number): string {
  return n.toLocaleString('cs-CZ', { style: 'currency', currency: 'CZK', minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function calcHours(start: string, end: string, overtimeMin: number = 0): number {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = (eh * 60 + em) - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60
  mins += overtimeMin
  return Math.round(mins / 60 * 100) / 100
}

function calcNightHours(start: string, end: string, overtimeMin: number = 0): number {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let startMins = sh * 60 + sm
  let endMins = eh * 60 + em
  if (endMins <= startMins) endMins += 24 * 60
  endMins += overtimeMin
  let night = 0
  for (let m = startMins; m < endMins; m++) {
    const hourOfDay = (m % (24 * 60)) / 60
    if (hourOfDay >= 22 || hourOfDay < 6) night++
  }
  return Math.round(night / 60 * 100) / 100
}

function timeOptions(startHour: number, endHour: number, includeEnd: boolean = false): string[] {
  const opts: string[] = []
  for (let h = startHour; h <= endHour; h++) {
    for (let m = 0; m < 60; m += 15) {
      if (h === endHour && m > 0 && !includeEnd) break
      opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
    }
  }
  if (includeEnd && !opts.includes('23:59')) opts.push('23:59')
  return opts
}

const startTimeOpts = timeOptions(6, 23)
const endTimeOpts = timeOptions(6, 23, true)
const overtimeOpts = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240]

// ─── Czech account → IBAN conversion ────────────────────────
function czechAccountToIBAN(account: string): string {
  // Input: "1234567890/0800" or "19-1234567890/0100"
  const clean = account.replace(/\s/g, '')
  const slashIdx = clean.indexOf('/')
  if (slashIdx === -1) return clean // fallback

  const bankCode = clean.substring(slashIdx + 1) // "0800"
  const accPart = clean.substring(0, slashIdx)     // "1234567890" or "19-1234567890"

  let prefix = '0'
  let baseNumber = accPart

  const dashIdx = accPart.indexOf('-')
  if (dashIdx !== -1) {
    prefix = accPart.substring(0, dashIdx)
    baseNumber = accPart.substring(dashIdx + 1)
  }

  // Pad: prefix to 6 digits, base number to 10 digits
  const paddedPrefix = prefix.padStart(6, '0')
  const paddedBase = baseNumber.padStart(10, '0')

  // BBAN = bankCode (4) + prefix (6) + account (10) = 20 digits
  const bban = bankCode + paddedPrefix + paddedBase

  // Calculate check digits
  // Move "CZ00" to end as numbers: C=12, Z=35, so "123500" + bban
  const numStr = bban + '123500'
  // Modulo 97 on large number (string-based)
  let remainder = 0
  for (let i = 0; i < numStr.length; i++) {
    remainder = (remainder * 10 + parseInt(numStr[i])) % 97
  }
  const checkDigits = String(98 - remainder).padStart(2, '0')

  return `CZ${checkDigits}${bban}`
}

// ─── SPD QR code string ─────────────────────────────────────
function generateSPD(account: string, amount: number, msg: string): string {
  const cappedAmount = Math.min(Math.max(amount, 0), 11400)
  const iban = czechAccountToIBAN(account)
  const parts = [
    'SPD*1.0',
    `ACC:${iban}`,
    `AM:${cappedAmount.toFixed(2)}`,
    'CC:CZK',
    `MSG:${msg.substring(0, 60)}`,
  ]
  return parts.join('*')
}

// ─── QR Code Component ──────────────────────────────────────
function QrCode({ data, size = 180 }: { data: string; size?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if ((window as any).QRCode) { setLoaded(true); return }
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
    script.onload = () => setLoaded(true)
    document.head.appendChild(script)
  }, [])

  useEffect(() => {
    if (!loaded || !ref.current) return
    ref.current.innerHTML = ''
    new (window as any).QRCode(ref.current, {
      text: data,
      width: size,
      height: size,
      correctLevel: (window as any).QRCode.CorrectLevel.M,
    })
  }, [loaded, data, size])

  return <div ref={ref} className="inline-block" />
}

// ─── Email Modal ─────────────────────────────────────────────
function EmailModal({ open, onClose, onSend, defaultEmail, sending }: {
  open: boolean
  onClose: () => void
  onSend: (email: string) => void
  defaultEmail: string
  sending: boolean
}) {
  const [email, setEmail] = useState(defaultEmail)

  useEffect(() => { if (open) setEmail(defaultEmail) }, [open, defaultEmail])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Odeslat schválené výkazy</h3>
        <p className="text-sm text-gray-500 mb-4">Všechny schválené výkazy za tento měsíc se odešlou jako PDF příloha.</p>
        <label className="text-xs text-gray-500 block mb-1">E-mail příjemce</label>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-orange-400 mb-4"
          placeholder="veronika.cesakova@gmail.com"
        />
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Zrušit</button>
          <button onClick={() => onSend(email)} disabled={sending || !email.includes('@')}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {sending ? 'Odesílám…' : 'Odeslat'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ──────────────────────────────────────────
export default function ApprovePage() {
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [summaries, setSummaries] = useState<MonthSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState<'ok' | 'err'>('ok')

  const [selectedWorker, setSelectedWorker] = useState<string | null>(null)
  const [detailRows, setDetailRows] = useState<TimesheetRow[]>([])
  const [adjustments, setAdjustments] = useState<Record<string, Adjustments>>({})

  const [showAddRow, setShowAddRow] = useState(false)
  const [newRow, setNewRow] = useState({ date: '', start: '14:00', end: '22:00', overtime: 0, note: '' })

  // Email modal
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [emailSending, setEmailSending] = useState(false)

  // All detail rows keyed by worker id (for PDF generation)
  const [allWorkerRows, setAllWorkerRows] = useState<Record<string, TimesheetRow[]>>({})

  const [monthDate, setMonthDate] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  const showMsg = (text: string, type: 'ok' | 'err' = 'ok') => {
    setMessage(text)
    setMessageType(type)
    setTimeout(() => setMessage(''), 4000)
  }

  const monthNames = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec']
  const qrMonth = monthNames[monthDate.getMonth()]

  // ─── Load current user ────────────────────────────────────
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) {
        supabase.from('users').select('*').eq('email', data.user.email).single()
          .then(({ data: u }) => setCurrentUser(u))
      }
    })
  }, [])

  // ─── Load data ────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true)
    const mDb = monthDbValue(monthDate)
    const endDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate()
    const endDate = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`

    const { data: workerData } = await supabase.from('users').select('*').neq('role', '').order('name')
    const { data: tsData } = await supabase.from('timesheets').select('*')
      .gte('work_date', mDb).lte('work_date', endDate).is('deleted_at', null).order('work_date')
    const { data: reportData } = await supabase.from('monthly_reports').select('*')
      .eq('month', mDb).is('deleted_at', null)
    const { data: tipsData } = await supabase.from('daily_tips').select('*')
      .gte('shift_date', mDb).lte('shift_date', endDate)

    const ws: Worker[] = workerData || []
    const rows = tsData || []
    const reports = reportData || []

    const tipsByDate: Record<string, number> = {}
    ;(tipsData || []).forEach((t: any) => {
      tipsByDate[t.shift_date] = (tipsByDate[t.shift_date] || 0) + Number(t.total_tips || 0)
    })

    // Build per-worker rows map
    const workerRowsMap: Record<string, TimesheetRow[]> = {}

    const sums: MonthSummary[] = ws.map(w => {
      const workerRows = rows.filter((r: any) => r.user_id === w.id)
      workerRowsMap[w.id] = workerRows as TimesheetRow[]
      const activeRows = workerRows.filter((r: any) => !r.rejected_at)
      const report = reports.find((r: any) => r.user_id === w.id)

      let tipShare = 0
      const workedDates = new Set(activeRows.map((r: any) => r.work_date))
      workedDates.forEach(date => {
        if (tipsByDate[date]) {
          const uniqueWorkers = new Set(rows.filter((r: any) => r.work_date === date && !r.rejected_at).map((r: any) => r.user_id))
          tipShare += tipsByDate[date] / uniqueWorkers.size
        }
      })

      const totalHours = activeRows.reduce((s: number, r: any) => s + Number(r.hours_worked || 0), 0)
      const nightHours = activeRows.reduce((s: number, r: any) => s + Number(r.night_hours || 0), 0)
      const wage = Math.round(totalHours * w.hourly_rate)

      const bonus = report ? Number(report.bonus || 0) : 0
      const consumption = report ? Number(report.consumption || 0) : 0
      const penalty = report ? Number(report.penalty || 0) : 0
      const tips = report ? Number(report.tips || 0) : Math.round(tipShare)
      const payout = wage + tips + bonus - consumption - penalty

      let status = 'draft'
      if (report?.status === 'approved') status = 'approved'
      else if (report?.status === 'submitted') status = 'submitted'
      else if (workerRows.length > 0 && workerRows.some((r: any) => r.status === 'submitted')) status = 'submitted'

      return {
        worker: w, totalHours: Math.round(totalHours * 100) / 100, nightHours: Math.round(nightHours * 100) / 100,
        wage, tips, bonus, consumption, penalty, payout, status,
        timesheetIds: workerRows.map((r: any) => r.id),
      }
    })

    setSummaries(sums)
    setAllWorkerRows(workerRowsMap)

    const adj: Record<string, Adjustments> = {}
    sums.forEach(s => {
      adj[s.worker.id] = { tips: String(s.tips || 0), bonus: String(s.bonus || 0), consumption: String(s.consumption || 0), penalty: String(s.penalty || 0) }
    })
    setAdjustments(adj)
    setLoading(false)
  }, [monthDate])

  useEffect(() => { loadData() }, [loadData])

  // ─── Load detail ──────────────────────────────────────────
  const loadDetail = useCallback(async (workerId: string) => {
    const mDb = monthDbValue(monthDate)
    const endDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate()
    const endDate = `${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`

    const { data } = await supabase.from('timesheets').select('*')
      .eq('user_id', workerId).gte('work_date', mDb).lte('work_date', endDate)
      .is('deleted_at', null).order('work_date')

    setDetailRows(data || [])
    setSelectedWorker(workerId)
    setShowAddRow(false)
    setNewRow({ date: '', start: '14:00', end: '22:00', overtime: 0, note: '' })
  }, [monthDate])

  // ─── Reject / unreject ────────────────────────────────────
  const toggleReject = async (rowId: string, currentlyRejected: boolean) => {
    setSaving(true)
    await supabase.from('timesheets').update(
      currentlyRejected ? { rejected_at: null, rejected_by: null } : { rejected_at: new Date().toISOString(), rejected_by: currentUser?.id || null }
    ).eq('id', rowId)
    await loadDetail(selectedWorker!)
    await loadData()
    setSaving(false)
  }

  // ─── Add admin row ────────────────────────────────────────
  const addAdminRow = async () => {
    if (!newRow.date || !selectedWorker) return
    setSaving(true)
    const ot = Number(newRow.overtime) || 0
    const hours = calcHours(newRow.start, newRow.end, ot)
    const night = calcNightHours(newRow.start, newRow.end, ot)

    const { error } = await supabase.from('timesheets').insert({
      user_id: selectedWorker, work_date: newRow.date,
      actual_start: newRow.start, actual_end: newRow.end,
      hours_worked: hours, night_hours: night,
      source: 'admin', status: 'submitted',
      added_by_admin: currentUser?.id || null,
      admin_note: ot > 0 ? `${newRow.note ? newRow.note + ' | ' : ''}Přesčas +${ot} min` : (newRow.note || null),
    })

    if (error) showMsg('Chyba: ' + error.message, 'err')
    else {
      showMsg('Řádek přidán')
      setNewRow({ date: '', start: '14:00', end: '22:00', overtime: 0, note: '' })
      setShowAddRow(false)
    }
    await loadDetail(selectedWorker)
    await loadData()
    setSaving(false)
  }

  // ─── Upsert monthly report ────────────────────────────────
  const upsertReport = async (workerId: string, extraFields: Record<string, any> = {}) => {
    const mDb = monthDbValue(monthDate)
    const adj = adjustments[workerId]
    const summary = summaries.find(s => s.worker.id === workerId)
    if (!adj || !summary) return

    const tips = Number(adj.tips) || 0
    const bonus = Number(adj.bonus) || 0
    const consumption = Number(adj.consumption) || 0
    const penalty = Number(adj.penalty) || 0
    const payout = summary.wage + tips + bonus - consumption - penalty

    const payload = {
      user_id: workerId, month: mDb,
      total_hours: summary.totalHours, manual_hours: 0,
      hourly_rate: summary.worker.hourly_rate,
      wage_total: summary.wage, tips_total: tips, tips, bonus, consumption, penalty,
      payout_total: payout,
      updated_at: new Date().toISOString(),
      ...extraFields,
    }

    const { data: existing } = await supabase.from('monthly_reports').select('id')
      .eq('user_id', workerId).eq('month', mDb).is('deleted_at', null).maybeSingle()

    if (existing) await supabase.from('monthly_reports').update(payload).eq('id', existing.id)
    else await supabase.from('monthly_reports').insert({ ...payload, status: extraFields.status || 'draft' })
  }

  const handleSave = async (workerId: string) => {
    setSaving(true)
    await upsertReport(workerId)
    await loadData()
    setSaving(false)
    showMsg('Uloženo')
  }

  // ─── Approve ──────────────────────────────────────────────
  const handleApprove = async (workerId: string) => {
    setSaving(true)
    await upsertReport(workerId, { status: 'approved', approved_at: new Date().toISOString(), approved_by: currentUser?.id || null })

    const mDb = monthDbValue(monthDate)
    await supabase.from('monthly_reports')
      .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: currentUser?.id || null })
      .eq('user_id', workerId).eq('month', mDb).is('deleted_at', null)

    const summary = summaries.find(s => s.worker.id === workerId)
    if (summary && summary.timesheetIds.length > 0) {
      await supabase.from('timesheets').update({ status: 'approved' }).in('id', summary.timesheetIds)
    }

    await loadData()
    if (selectedWorker === workerId) await loadDetail(workerId)
    setSaving(false)
    showMsg('Timesheet schválen ✓')
  }

  // ─── Reopen ───────────────────────────────────────────────
  const handleReopen = async (workerId: string) => {
    setSaving(true)
    const mDb = monthDbValue(monthDate)
    await supabase.from('monthly_reports')
      .update({ status: 'submitted', approved_at: null, approved_by: null, updated_at: new Date().toISOString() })
      .eq('user_id', workerId).eq('month', mDb).is('deleted_at', null)

    const summary = summaries.find(s => s.worker.id === workerId)
    if (summary && summary.timesheetIds.length > 0) {
      await supabase.from('timesheets').update({ status: 'submitted' }).in('id', summary.timesheetIds)
    }

    await loadData()
    if (selectedWorker === workerId) await loadDetail(workerId)
    setSaving(false)
    showMsg('Timesheet vrácen ke schválení')
  }

  // ─── Return to draft ──────────────────────────────────────
  const handleReturnToDraft = async (workerId: string) => {
    setSaving(true)
    const mDb = monthDbValue(monthDate)

    await supabase.from('monthly_reports')
      .update({ status: 'draft', approved_at: null, approved_by: null, updated_at: new Date().toISOString() })
      .eq('user_id', workerId).eq('month', mDb).is('deleted_at', null)

    const summary = summaries.find(s => s.worker.id === workerId)
    if (summary && summary.timesheetIds.length > 0) {
      await supabase.from('timesheets')
        .update({ status: 'draft' })
        .in('id', summary.timesheetIds)
    }

    await loadData()
    if (selectedWorker === workerId) await loadDetail(workerId)
    setSaving(false)
    showMsg('Vráceno brigádníkovi k přepracování')
  }

  // ─── Send email with PDF (via API route) ──────────────────
  const handleSendEmail = async (toEmail: string) => {
    setEmailSending(true)
    const approvedSummaries = summaries.filter(s => s.status === 'approved')

    if (approvedSummaries.length === 0) {
      showMsg('Žádné schválené výkazy k odeslání', 'err')
      setEmailSending(false)
      return
    }

    // Build payload for API route
    const payload = {
      to: toEmail,
      month: monthLabel(monthDate),
      summaries: approvedSummaries.map(s => ({
        name: s.worker.name,
        email: s.worker.email,
        bank_account: s.worker.bank_account,
        hourly_rate: s.worker.hourly_rate,
        totalHours: s.totalHours,
        nightHours: s.nightHours,
        wage: s.wage,
        tips: s.tips,
        bonus: s.bonus,
        consumption: s.consumption,
        penalty: s.penalty,
        payout: s.payout,
        rows: (allWorkerRows[s.worker.id] || []).map(r => ({
          date: r.work_date,
          start: r.actual_start,
          end: r.actual_end,
          hours: r.hours_worked,
          night: r.night_hours,
          source: r.source,
          rejected: !!r.rejected_at,
          note: r.admin_note,
        })),
      })),
    }

    try {
      const res = await fetch('/api/send-timesheets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.ok) {
        showMsg('E-mail odeslán ✓')
        setEmailModalOpen(false)
      } else {
        const err = await res.json().catch(() => ({}))
        showMsg('Chyba odesílání: ' + (err.error || res.statusText), 'err')
      }
    } catch (e: any) {
      showMsg('Chyba: ' + e.message, 'err')
    }
    setEmailSending(false)
  }

  // ─── Derived ──────────────────────────────────────────────
  const selectedSummary = summaries.find(s => s.worker.id === selectedWorker)
  const isApproved = selectedSummary?.status === 'approved'
  const approvedCount = summaries.filter(s => s.status === 'approved').length

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-gray-400 hover:text-gray-600 text-sm">← Dashboard</a>
            <h1 className="text-lg font-semibold text-gray-900">Schvalování timesheetů</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <button onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">←</button>
              <span className="text-sm font-medium text-gray-700 min-w-[140px] text-center capitalize">{monthLabel(monthDate)}</span>
              <button onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">→</button>
            </div>
            {approvedCount > 0 && (
              <button onClick={() => setEmailModalOpen(true)}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700">
                Odeslat e-mailem ({approvedCount})
              </button>
            )}
          </div>
        </div>
      </header>

      {message && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${messageType === 'ok' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{message}</div>
      )}

      <EmailModal
        open={emailModalOpen}
        onClose={() => setEmailModalOpen(false)}
        onSend={handleSendEmail}
        defaultEmail="istavitel@gmail.com"
        sending={emailSending}
      />

      <main className="max-w-6xl mx-auto p-6">
        {loading ? (
          <div className="text-center text-gray-400 py-20">Načítám…</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Left — worker list */}
            <div className="lg:col-span-1 space-y-2">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Brigádníci — {monthLabel(monthDate)}</h2>
              {summaries.map(s => (
                <button key={s.worker.id} onClick={() => loadDetail(s.worker.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${selectedWorker === s.worker.id ? 'border-orange-400 bg-orange-50 shadow-sm' : 'border-gray-200 bg-white hover:border-gray-300'}`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-gray-900">{s.worker.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      s.status === 'approved' ? 'bg-green-100 text-green-700' : s.status === 'submitted' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {s.status === 'approved' ? 'Schváleno' : s.status === 'submitted' ? 'Ke schválení' : 'Rozpracovaný'}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    <span>{s.totalHours} h</span>
                    <span>{s.worker.hourly_rate} Kč/h</span>
                    <span className="font-semibold text-gray-700">{formatCZK(s.payout)}</span>
                  </div>
                </button>
              ))}
            </div>

            {/* Right — detail */}
            <div className="lg:col-span-2">
              {!selectedWorker ? (
                <div className="text-center text-gray-400 py-20 bg-white rounded-xl border border-gray-200">Vyber brigádníka vlevo</div>
              ) : selectedSummary && (
                <div className="space-y-4">

                  <div className="bg-white rounded-xl border border-gray-200 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-lg font-semibold text-gray-900">{selectedSummary.worker.name}</h3>
                        <span className={`inline-block mt-1 text-xs px-2 py-0.5 rounded-full font-medium ${
                          isApproved ? 'bg-green-100 text-green-700' : selectedSummary.status === 'submitted' ? 'bg-yellow-100 text-yellow-700' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {isApproved ? 'Schváleno manažerem' : selectedSummary.status === 'submitted' ? 'Ke schválení' : 'Rozpracovaný'}
                        </span>
                      </div>
                      <div className="flex gap-2">
                        {isApproved ? (
                          <>
                            <button onClick={() => handleReopen(selectedWorker)} disabled={saving}
                              className="px-4 py-2 text-sm border border-orange-300 text-orange-600 rounded-lg hover:bg-orange-50 disabled:opacity-50">
                              Editovat
                            </button>
                            <button onClick={() => handleReturnToDraft(selectedWorker)} disabled={saving}
                              className="px-4 py-2 text-sm border border-red-300 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50">
                              Vrátit k přepracování
                            </button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => handleSave(selectedWorker)} disabled={saving}
                              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                              Uložit změny
                            </button>
                            <button onClick={() => handleApprove(selectedWorker)} disabled={saving}
                              className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50">
                              Schválit
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-gray-400 text-xs">Hodiny</div>
                        <div className="font-semibold text-gray-900">{selectedSummary.totalHours} h</div>
                        {selectedSummary.nightHours > 0 && <div className="text-xs text-gray-400">nočních: {selectedSummary.nightHours} h</div>}
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-gray-400 text-xs">Mzda</div>
                        <div className="font-semibold text-gray-900">{formatCZK(selectedSummary.wage)}</div>
                        <div className="text-xs text-gray-400">{selectedSummary.worker.hourly_rate} Kč/h</div>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-gray-400 text-xs">Dýška</div>
                        <div className="font-semibold text-gray-900">{formatCZK(selectedSummary.tips)}</div>
                      </div>
                      <div className="bg-orange-50 rounded-lg p-3 border border-orange-200">
                        <div className="text-orange-500 text-xs">K výplatě</div>
                        <div className="font-bold text-orange-700 text-lg">{formatCZK(selectedSummary.payout)}</div>
                        {selectedSummary.payout > 11400 && <div className="text-xs text-red-500">QR max: {formatCZK(11400)}</div>}
                      </div>
                    </div>

                    {!isApproved && adjustments[selectedWorker] && (
                      <div className="mt-4 pt-4 border-t border-gray-100">
                        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Úpravy</h4>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          {(['tips', 'bonus', 'consumption', 'penalty'] as const).map(field => (
                            <div key={field}>
                              <label className="text-xs text-gray-500">
                                {field === 'tips' ? 'Dýška (Kč)' : field === 'bonus' ? 'Odměna (Kč)' : field === 'consumption' ? 'Spotřeba (Kč)' : 'Pokuta (Kč)'}
                              </label>
                              <input type="number" value={adjustments[selectedWorker][field]}
                                onChange={e => setAdjustments(prev => ({ ...prev, [selectedWorker!]: { ...prev[selectedWorker!], [field]: e.target.value } }))}
                                className="w-full mt-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-orange-400" />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {isApproved && (selectedSummary.bonus > 0 || selectedSummary.consumption > 0 || selectedSummary.penalty > 0) && (
                      <div className="mt-4 pt-4 border-t border-gray-100 flex gap-6 text-sm">
                        {selectedSummary.bonus > 0 && <div><span className="text-gray-400">Odměna:</span> <span className="text-green-600">+{formatCZK(selectedSummary.bonus)}</span></div>}
                        {selectedSummary.consumption > 0 && <div><span className="text-gray-400">Spotřeba:</span> <span className="text-red-500">-{formatCZK(selectedSummary.consumption)}</span></div>}
                        {selectedSummary.penalty > 0 && <div><span className="text-gray-400">Pokuta:</span> <span className="text-red-500">-{formatCZK(selectedSummary.penalty)}</span></div>}
                      </div>
                    )}
                  </div>

                  {/* QR code — only when approved */}
                  {isApproved && selectedSummary.worker.bank_account && (
                    <div className="bg-white rounded-xl border border-green-200 p-6 text-center">
                      <h4 className="text-sm font-semibold text-gray-700 mb-4">QR platba</h4>
                      <QrCode
                        data={generateSPD(selectedSummary.worker.bank_account, selectedSummary.payout, `Prosecco ${qrMonth}`)}
                        size={200}
                      />
                      <div className="mt-4 space-y-1">
                        <p className="text-sm font-medium text-gray-700">
                          {formatCZK(Math.min(selectedSummary.payout, 11400))} → {selectedSummary.worker.bank_account}
                        </p>
                        <p className="text-xs text-gray-400">Zpráva: Prosecco {qrMonth}</p>
                        <p className="text-xs text-gray-300">IBAN: {czechAccountToIBAN(selectedSummary.worker.bank_account)}</p>
                        {selectedSummary.payout > 11400 && (
                          <p className="text-xs text-red-500 mt-2">
                            Celkem {formatCZK(selectedSummary.payout)} — v QR max {formatCZK(11400)}, doplatek {formatCZK(selectedSummary.payout - 11400)} zvlášť
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  {isApproved && !selectedSummary.worker.bank_account && (
                    <div className="bg-yellow-50 rounded-xl border border-yellow-200 p-4 text-center text-sm text-yellow-700">
                      Brigádník nemá zadaný účet — <a href="/users" className="underline">doplnit ve správě uživatelů</a>
                    </div>
                  )}

                  {/* Timesheet rows */}
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-gray-700">Vykázané směny</h4>
                      {!isApproved && (
                        <button onClick={() => setShowAddRow(!showAddRow)}
                          className="text-xs px-3 py-1 bg-orange-100 text-orange-700 rounded-lg hover:bg-orange-200">
                          {showAddRow ? 'Zrušit' : '+ Přidat řádek'}
                        </button>
                      )}
                    </div>

                    {showAddRow && (
                      <div className="px-5 py-4 bg-orange-50 border-b border-orange-100">
                        <div className="flex flex-wrap items-end gap-3">
                          <div>
                            <label className="text-xs text-gray-500 block mb-1">Datum</label>
                            <input type="date" value={newRow.date} onChange={e => setNewRow(p => ({ ...p, date: e.target.value }))}
                              className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white" />
                          </div>
                          <div>
                            <label className="text-xs text-gray-500 block mb-1">Od</label>
                            <select value={newRow.start} onChange={e => setNewRow(p => ({ ...p, start: e.target.value }))}
                              className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white">
                              {startTimeOpts.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-gray-500 block mb-1">Do</label>
                            <select value={newRow.end} onChange={e => setNewRow(p => ({ ...p, end: e.target.value }))}
                              className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white">
                              {endTimeOpts.map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="text-xs text-gray-500 block mb-1">Přesčas po půlnoci</label>
                            <select value={newRow.overtime} onChange={e => setNewRow(p => ({ ...p, overtime: Number(e.target.value) }))}
                              className="px-2 py-1.5 text-sm border border-gray-300 rounded-lg bg-white">
                              {overtimeOpts.map(m => <option key={m} value={m}>{m === 0 ? '—' : `+${m} min`}</option>)}
                            </select>
                          </div>
                          <div className="flex-1 min-w-[100px]">
                            <label className="text-xs text-gray-500 block mb-1">Poznámka</label>
                            <input type="text" placeholder="Volitelné…" value={newRow.note}
                              onChange={e => setNewRow(p => ({ ...p, note: e.target.value }))}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg" />
                          </div>
                          <button onClick={addAdminRow} disabled={saving || !newRow.date}
                            className="px-4 py-1.5 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50">
                            Přidat
                          </button>
                        </div>
                        {newRow.date && (
                          <div className="mt-2 text-xs text-gray-500">
                            {calcHours(newRow.start, newRow.end, Number(newRow.overtime)).toFixed(1)} h celkem
                            {Number(newRow.overtime) > 0 && ` (přesčas +${newRow.overtime} min)`}
                          </div>
                        )}
                      </div>
                    )}

                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-gray-400 uppercase tracking-wider border-b border-gray-100">
                            <th className="px-5 py-2">Datum</th>
                            <th className="px-3 py-2">Od</th>
                            <th className="px-3 py-2">Do</th>
                            <th className="px-3 py-2">Hodiny</th>
                            <th className="px-3 py-2">Noční</th>
                            <th className="px-3 py-2">Zdroj</th>
                            <th className="px-3 py-2 text-right">Akce</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailRows.map(row => {
                            const isRejected = !!row.rejected_at
                            const isAdminRow = row.source === 'admin' || !!row.added_by_admin
                            return (
                              <tr key={row.id} className={`border-b border-gray-50 ${isRejected ? 'bg-red-50/50' : isAdminRow ? 'bg-blue-50/30' : ''}`}>
                                <td className={`px-5 py-2.5 ${isRejected ? 'line-through text-gray-400' : 'text-gray-900'}`}>{formatDate(row.work_date)}</td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : ''}`}>{row.actual_start}</td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : ''}`}>{row.actual_end}</td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : 'font-medium'}`}>{Number(row.hours_worked || 0).toFixed(1)}</td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : ''}`}>{Number(row.night_hours || 0).toFixed(1)}</td>
                                <td className="px-3 py-2.5">
                                  {isAdminRow ? <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded">admin</span>
                                    : <span className="text-xs text-gray-400">{row.source || 'brigádník'}</span>}
                                  {row.admin_note && <span className="block text-xs text-gray-400 italic mt-0.5">{row.admin_note}</span>}
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  {!isApproved && (
                                    <button onClick={() => toggleReject(row.id, isRejected)} disabled={saving}
                                      className={`text-xs px-2 py-1 rounded ${isRejected ? 'bg-green-100 text-green-600 hover:bg-green-200' : 'bg-red-100 text-red-600 hover:bg-red-200'} disabled:opacity-50`}>
                                      {isRejected ? 'Obnovit' : 'Neschválit'}
                                    </button>
                                  )}
                                  {isApproved && isRejected && <span className="text-xs text-red-400">Neschváleno</span>}
                                </td>
                              </tr>
                            )
                          })}
                          {detailRows.length === 0 && (
                            <tr><td colSpan={7} className="px-5 py-8 text-center text-gray-400">Žádné vykázané směny</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {!isApproved && !showAddRow && (
                      <div className="px-5 py-3 border-t border-gray-100">
                        <button onClick={() => setShowAddRow(true)} className="text-xs text-orange-500 hover:text-orange-700">+ Přidat řádek ručně</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}