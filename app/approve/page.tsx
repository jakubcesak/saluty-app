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
  status: 'draft' | 'submitted' | 'approved'
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
  admin_start: string | null
  admin_end: string | null
  admin_night: number | null
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

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function formatDate(s: string): string {
  const d = new Date(s + 'T00:00:00')
  return d.toLocaleDateString('cs-CZ', { weekday: 'short', day: 'numeric', month: 'numeric' })
}

function formatCZK(n: number): string {
  return n.toLocaleString('cs-CZ', { style: 'currency', currency: 'CZK', minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function calcHours(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let mins = (eh * 60 + em) - (sh * 60 + sm)
  if (mins < 0) mins += 24 * 60 // overnight
  return Math.round(mins / 60 * 100) / 100
}

function calcNightHours(start: string, end: string): number {
  // Night hours: 22:00 - 06:00
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  let startMins = sh * 60 + sm
  let endMins = eh * 60 + em
  if (endMins <= startMins) endMins += 24 * 60

  let night = 0
  for (let m = startMins; m < endMins; m++) {
    const hour = (m % (24 * 60)) / 60
    if (hour >= 22 || hour < 6) night++
  }
  return Math.round(night / 60 * 100) / 100
}

// CZ QR payment string (SPD format)
function generateSPD(account: string, amount: number, message: string): string {
  // account format: 123456789/0100 -> CZ IBAN or just use as-is
  const cappedAmount = Math.min(amount, 11400)
  const parts = [
    'SPD*1.0',
    `ACC:${account.replace(/\s/g, '')}`,
    `AM:${cappedAmount.toFixed(2)}`,
    'CC:CZK',
    `MSG:${message.substring(0, 60)}`,
  ]
  return parts.join('*')
}

// ─── QR Code Component ──────────────────────────────────────
function QrCode({ data, size = 160 }: { data: string; size?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if ((window as any).QRCode) {
      setLoaded(true)
      return
    }
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

// ─── Main Component ──────────────────────────────────────────
export default function ApprovePage() {
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [summaries, setSummaries] = useState<MonthSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState<'ok' | 'err'>('ok')

  // Detail view
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null)
  const [detailRows, setDetailRows] = useState<TimesheetRow[]>([])
  const [adjustments, setAdjustments] = useState<Record<string, Adjustments>>({})

  // Add row form
  const [showAddRow, setShowAddRow] = useState(false)
  const [newRow, setNewRow] = useState({ date: '', start: '', end: '', note: '' })

  // Month navigation
  const [monthDate, setMonthDate] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })

  const showMsg = (text: string, type: 'ok' | 'err' = 'ok') => {
    setMessage(text)
    setMessageType(type)
    setTimeout(() => setMessage(''), 4000)
  }

  // ─── Load current user ────────────────────────────────────
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) {
        supabase.from('users').select('*').eq('email', data.user.email).single()
          .then(({ data: u }) => setCurrentUser(u))
      }
    })
  }, [])

  // ─── Load workers & summaries ─────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true)
    const mk = monthKey(monthDate)
    const startDate = `${mk}-01`
    const endDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate()
    const endDate = `${mk}-${String(endDay).padStart(2, '0')}`

    // Get workers
    const { data: workerData } = await supabase
      .from('users')
      .select('*')
      .eq('role', 'worker')
      .order('name')
    const ws: Worker[] = workerData || []
    setWorkers(ws)

    // Get timesheets for this month
    const { data: tsData } = await supabase
      .from('timesheets')
      .select('*')
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .is('deleted_at', null)
      .order('work_date')

    // Get monthly reports
    const { data: reportData } = await supabase
      .from('monthly_reports')
      .select('*')
      .eq('month', mk)

    const rows = tsData || []
    const reports = reportData || []

    // Get tips for this month
    const { data: tipsData } = await supabase
      .from('daily_tips')
      .select('*')
      .gte('shift_date', startDate)
      .lte('shift_date', endDate)

    // Calculate tip share per worker per month (equal split among workers who worked that day)
    const tipsByDate: Record<string, number> = {}
    ;(tipsData || []).forEach((t: any) => {
      tipsByDate[t.shift_date] = (tipsByDate[t.shift_date] || 0) + Number(t.total_tips || 0)
    })

    // Build summaries
    const sums: MonthSummary[] = ws.map(w => {
      const workerRows = rows.filter((r: any) => r.user_id === w.id)
      const activeRows = workerRows.filter((r: any) => !r.rejected_at)
      const report = reports.find((r: any) => r.user_id === w.id)

      // Calculate tip share: for each day the worker worked, split tips equally
      let tipShare = 0
      const workedDates = new Set(activeRows.map((r: any) => r.work_date))
      workedDates.forEach(date => {
        if (tipsByDate[date]) {
          const workersOnDay = rows.filter((r: any) => r.work_date === date && !r.rejected_at)
          const uniqueWorkers = new Set(workersOnDay.map((r: any) => r.user_id))
          tipShare += tipsByDate[date] / uniqueWorkers.size
        }
      })

      const totalHours = activeRows.reduce((s: number, r: any) => {
        const h = r.admin_start ? calcHours(r.admin_start, r.admin_end || r.actual_end) : r.hours_worked
        return s + h
      }, 0)
      const nightHours = activeRows.reduce((s: number, r: any) => {
        if (r.admin_night !== null) return s + r.admin_night
        return s + (r.night_hours || 0)
      }, 0)

      const wage = Math.round(totalHours * w.hourly_rate)
      const bonus = report ? Number(report.bonus || 0) : 0
      const consumption = report ? Number(report.consumption || 0) : 0
      const penalty = report ? Number(report.penalty || 0) : 0
      const tips = report && report.tips !== undefined ? Number(report.tips) : Math.round(tipShare)
      const payout = wage + tips + bonus - consumption - penalty

      // Determine status
      let status: 'draft' | 'submitted' | 'approved' = 'draft'
      if (report?.status === 'approved') status = 'approved'
      else if (workerRows.some((r: any) => r.status === 'submitted')) status = 'submitted'

      return {
        worker: w,
        totalHours: Math.round(totalHours * 100) / 100,
        nightHours: Math.round(nightHours * 100) / 100,
        wage,
        tips,
        bonus,
        consumption,
        penalty,
        payout,
        status,
        timesheetIds: workerRows.map((r: any) => r.id),
      }
    })

    setSummaries(sums)

    // Init adjustments
    const adj: Record<string, Adjustments> = {}
    sums.forEach(s => {
      adj[s.worker.id] = {
        tips: String(s.tips || 0),
        bonus: String(s.bonus || 0),
        consumption: String(s.consumption || 0),
        penalty: String(s.penalty || 0),
      }
    })
    setAdjustments(adj)

    setLoading(false)
  }, [monthDate])

  useEffect(() => { loadData() }, [loadData])

  // ─── Load detail rows ─────────────────────────────────────
  const loadDetail = useCallback(async (workerId: string) => {
    const mk = monthKey(monthDate)
    const startDate = `${mk}-01`
    const endDay = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0).getDate()
    const endDate = `${mk}-${String(endDay).padStart(2, '0')}`

    const { data } = await supabase
      .from('timesheets')
      .select('*')
      .eq('user_id', workerId)
      .gte('work_date', startDate)
      .lte('work_date', endDate)
      .is('deleted_at', null)
      .order('work_date')

    setDetailRows(data || [])
    setSelectedWorker(workerId)
    setShowAddRow(false)
    setNewRow({ date: '', start: '', end: '', note: '' })
  }, [monthDate])

  // ─── Reject / unreject row ────────────────────────────────
  const toggleReject = async (rowId: string, currentlyRejected: boolean) => {
    setSaving(true)
    if (currentlyRejected) {
      await supabase.from('timesheets').update({
        rejected_at: null,
        rejected_by: null,
      }).eq('id', rowId)
    } else {
      await supabase.from('timesheets').update({
        rejected_at: new Date().toISOString(),
        rejected_by: currentUser?.id || null,
      }).eq('id', rowId)
    }
    await loadDetail(selectedWorker!)
    await loadData()
    setSaving(false)
  }

  // ─── Add admin row ────────────────────────────────────────
  const addAdminRow = async () => {
    if (!newRow.date || !newRow.start || !newRow.end || !selectedWorker) return
    setSaving(true)
    const hours = calcHours(newRow.start, newRow.end)
    const night = calcNightHours(newRow.start, newRow.end)

    await supabase.from('timesheets').insert({
      user_id: selectedWorker,
      work_date: newRow.date,
      actual_start: newRow.start,
      actual_end: newRow.end,
      hours_worked: hours,
      night_hours: night,
      source: 'admin',
      status: 'submitted',
      added_by_admin: currentUser?.id || null,
      admin_note: newRow.note || null,
    })

    setNewRow({ date: '', start: '', end: '', note: '' })
    setShowAddRow(false)
    await loadDetail(selectedWorker)
    await loadData()
    setSaving(false)
    showMsg('Řádek přidán')
  }

  // ─── Save adjustments ─────────────────────────────────────
  const saveAdjustments = async (workerId: string) => {
    setSaving(true)
    const mk = monthKey(monthDate)
    const adj = adjustments[workerId]
    if (!adj) return

    const { data: existing } = await supabase
      .from('monthly_reports')
      .select('id')
      .eq('user_id', workerId)
      .eq('month', mk)
      .maybeSingle()

    const payload = {
      user_id: workerId,
      month: mk,
      tips: Number(adj.tips) || 0,
      bonus: Number(adj.bonus) || 0,
      consumption: Number(adj.consumption) || 0,
      penalty: Number(adj.penalty) || 0,
    }

    if (existing) {
      await supabase.from('monthly_reports').update(payload).eq('id', existing.id)
    } else {
      await supabase.from('monthly_reports').insert(payload)
    }

    await loadData()
    setSaving(false)
    showMsg('Uloženo')
  }

  // ─── Approve ──────────────────────────────────────────────
  const handleApprove = async (workerId: string) => {
    setSaving(true)
    const mk = monthKey(monthDate)

    // Save adjustments first
    await saveAdjustments(workerId)

    // Update or create monthly_report as approved
    const { data: existing } = await supabase
      .from('monthly_reports')
      .select('id')
      .eq('user_id', workerId)
      .eq('month', mk)
      .maybeSingle()

    const approvalPayload = {
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: currentUser?.id || null,
    }

    if (existing) {
      await supabase.from('monthly_reports').update(approvalPayload).eq('id', existing.id)
    } else {
      await supabase.from('monthly_reports').insert({
        user_id: workerId,
        month: mk,
        tips: Number(adjustments[workerId]?.tips) || 0,
        bonus: Number(adjustments[workerId]?.bonus) || 0,
        consumption: Number(adjustments[workerId]?.consumption) || 0,
        penalty: Number(adjustments[workerId]?.penalty) || 0,
        ...approvalPayload,
      })
    }

    // Update all timesheet rows status
    const summary = summaries.find(s => s.worker.id === workerId)
    if (summary) {
      await supabase.from('timesheets')
        .update({ status: 'approved' })
        .in('id', summary.timesheetIds)
    }

    await loadData()
    if (selectedWorker === workerId) await loadDetail(workerId)
    setSaving(false)
    showMsg('Timesheet schválen ✓')
  }

  // ─── Reopen (edit approved) ───────────────────────────────
  const handleReopen = async (workerId: string) => {
    setSaving(true)
    const mk = monthKey(monthDate)

    await supabase.from('monthly_reports')
      .update({ status: 'submitted', approved_at: null, approved_by: null })
      .eq('user_id', workerId)
      .eq('month', mk)

    const summary = summaries.find(s => s.worker.id === workerId)
    if (summary) {
      await supabase.from('timesheets')
        .update({ status: 'submitted' })
        .in('id', summary.timesheetIds)
    }

    await loadData()
    if (selectedWorker === workerId) await loadDetail(workerId)
    setSaving(false)
    showMsg('Timesheet vrácen ke schválení')
  }

  // ─── Send email ───────────────────────────────────────────
  const handleSendEmail = (workerId: string) => {
    const summary = summaries.find(s => s.worker.id === workerId)
    if (!summary) return

    const mk = monthKey(monthDate)
    const w = summary.worker
    const cappedPayout = Math.min(summary.payout, 11400)

    const subject = encodeURIComponent(`Timesheet ${monthLabel(monthDate)} – ${w.name}`)
    const body = encodeURIComponent(
      `Timesheet: ${monthLabel(monthDate)}\n` +
      `Brigádník: ${w.name}\n` +
      `E-mail: ${w.email}\n` +
      `Bankovní účet: ${w.bank_account || '—'}\n\n` +
      `Odpracované hodiny: ${summary.totalHours} h\n` +
      `  z toho noční: ${summary.nightHours} h\n` +
      `Hodinová sazba: ${w.hourly_rate} Kč\n` +
      `Mzda: ${formatCZK(summary.wage)}\n\n` +
      `Dýška: ${formatCZK(summary.tips)}\n` +
      `Mimořádná odměna: ${formatCZK(summary.bonus)}\n` +
      `Spotřeba: -${formatCZK(summary.consumption)}\n` +
      `Pokuta: -${formatCZK(summary.penalty)}\n\n` +
      `CELKEM K VÝPLATĚ: ${formatCZK(summary.payout)}\n` +
      `(QR platba max: ${formatCZK(cappedPayout)})\n\n` +
      `---\nVygenerováno v systému Saluta`
    )

    window.open(`mailto:veronika.cesakova@gmail.com?subject=${subject}&body=${body}`, '_blank')
  }

  // ─── Derived state ────────────────────────────────────────
  const selectedSummary = summaries.find(s => s.worker.id === selectedWorker)
  const isApproved = selectedSummary?.status === 'approved'

  // ─── Render ───────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <a href="/" className="text-gray-400 hover:text-gray-600 text-sm">← Dashboard</a>
            <h1 className="text-lg font-semibold text-gray-900">Schvalování timesheetů</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() - 1, 1))}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              ←
            </button>
            <span className="text-sm font-medium text-gray-700 min-w-[140px] text-center capitalize">
              {monthLabel(monthDate)}
            </span>
            <button
              onClick={() => setMonthDate(new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 1))}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              →
            </button>
          </div>
        </div>
      </header>

      {/* Toast */}
      {message && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${
          messageType === 'ok' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
        }`}>
          {message}
        </div>
      )}

      <main className="max-w-6xl mx-auto p-6">
        {loading ? (
          <div className="text-center text-gray-400 py-20">Načítám…</div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* ─── Left: Workers list ─────────────────────── */}
            <div className="lg:col-span-1 space-y-2">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
                Brigádníci — {monthLabel(monthDate)}
              </h2>
              {summaries.length === 0 && (
                <p className="text-sm text-gray-400">Žádní brigádníci</p>
              )}
              {summaries.map(s => (
                <button
                  key={s.worker.id}
                  onClick={() => loadDetail(s.worker.id)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    selectedWorker === s.worker.id
                      ? 'border-orange-400 bg-orange-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-gray-900">{s.worker.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                      s.status === 'approved'
                        ? 'bg-green-100 text-green-700'
                        : s.status === 'submitted'
                        ? 'bg-yellow-100 text-yellow-700'
                        : 'bg-gray-100 text-gray-500'
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

            {/* ─── Right: Detail ──────────────────────────── */}
            <div className="lg:col-span-2">
              {!selectedWorker ? (
                <div className="text-center text-gray-400 py-20 bg-white rounded-xl border border-gray-200">
                  Vyber brigádníka vlevo
                </div>
              ) : selectedSummary && (
                <div className="space-y-4">
                  {/* Detail header */}
                  <div className="bg-white rounded-xl border border-gray-200 p-5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-lg font-semibold text-gray-900">
                        {selectedSummary.worker.name}
                      </h3>
                      <div className="flex gap-2">
                        {isApproved ? (
                          <>
                            <button
                              onClick={() => handleReopen(selectedWorker)}
                              disabled={saving}
                              className="px-4 py-2 text-sm border border-orange-300 text-orange-600 rounded-lg hover:bg-orange-50 disabled:opacity-50"
                            >
                              Vrátit ke schválení
                            </button>
                            <button
                              onClick={() => handleSendEmail(selectedWorker)}
                              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                            >
                              Odeslat e-mailem
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={() => saveAdjustments(selectedWorker)}
                              disabled={saving}
                              className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                            >
                              Uložit změny
                            </button>
                            <button
                              onClick={() => handleApprove(selectedWorker)}
                              disabled={saving}
                              className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                            >
                              Schválit
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Summary grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                      <div className="bg-gray-50 rounded-lg p-3">
                        <div className="text-gray-400 text-xs">Hodiny</div>
                        <div className="font-semibold text-gray-900">{selectedSummary.totalHours} h</div>
                        {selectedSummary.nightHours > 0 && (
                          <div className="text-xs text-gray-400">z toho nočních: {selectedSummary.nightHours} h</div>
                        )}
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
                        {selectedSummary.payout > 11400 && (
                          <div className="text-xs text-red-500">QR max: {formatCZK(11400)}</div>
                        )}
                      </div>
                    </div>

                    {/* Adjustments */}
                    {!isApproved && adjustments[selectedWorker] && (
                      <div className="mt-4 pt-4 border-t border-gray-100">
                        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Úpravy</h4>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div>
                            <label className="text-xs text-gray-500">Dýška (Kč)</label>
                            <input
                              type="number"
                              value={adjustments[selectedWorker].tips}
                              onChange={e => setAdjustments(prev => ({
                                ...prev,
                                [selectedWorker!]: { ...prev[selectedWorker!], tips: e.target.value }
                              }))}
                              className="w-full mt-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-orange-400"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">Odměna (Kč)</label>
                            <input
                              type="number"
                              value={adjustments[selectedWorker].bonus}
                              onChange={e => setAdjustments(prev => ({
                                ...prev,
                                [selectedWorker!]: { ...prev[selectedWorker!], bonus: e.target.value }
                              }))}
                              className="w-full mt-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-orange-400"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">Spotřeba (Kč)</label>
                            <input
                              type="number"
                              value={adjustments[selectedWorker].consumption}
                              onChange={e => setAdjustments(prev => ({
                                ...prev,
                                [selectedWorker!]: { ...prev[selectedWorker!], consumption: e.target.value }
                              }))}
                              className="w-full mt-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-orange-400"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-500">Pokuta (Kč)</label>
                            <input
                              type="number"
                              value={adjustments[selectedWorker].penalty}
                              onChange={e => setAdjustments(prev => ({
                                ...prev,
                                [selectedWorker!]: { ...prev[selectedWorker!], penalty: e.target.value }
                              }))}
                              className="w-full mt-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:border-orange-400"
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Approved adjustments (read-only) */}
                    {isApproved && (
                      <div className="mt-4 pt-4 border-t border-gray-100">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                          {selectedSummary.bonus > 0 && (
                            <div><span className="text-gray-400">Odměna:</span> <span className="text-green-600">+{formatCZK(selectedSummary.bonus)}</span></div>
                          )}
                          {selectedSummary.consumption > 0 && (
                            <div><span className="text-gray-400">Spotřeba:</span> <span className="text-red-500">-{formatCZK(selectedSummary.consumption)}</span></div>
                          )}
                          {selectedSummary.penalty > 0 && (
                            <div><span className="text-gray-400">Pokuta:</span> <span className="text-red-500">-{formatCZK(selectedSummary.penalty)}</span></div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* QR code (only when approved) */}
                  {isApproved && selectedSummary.worker.bank_account && (
                    <div className="bg-white rounded-xl border border-green-200 p-5 text-center">
                      <h4 className="text-sm font-semibold text-gray-700 mb-3">QR platba</h4>
                      <QrCode
                        data={generateSPD(
                          selectedSummary.worker.bank_account,
                          selectedSummary.payout,
                          `Vyplata ${selectedSummary.worker.name} ${monthLabel(monthDate)}`
                        )}
                        size={180}
                      />
                      <p className="mt-3 text-sm text-gray-500">
                        {selectedSummary.worker.bank_account} · {formatCZK(Math.min(selectedSummary.payout, 11400))}
                      </p>
                      {selectedSummary.payout > 11400 && (
                        <p className="text-xs text-red-500 mt-1">
                          Celkem k výplatě {formatCZK(selectedSummary.payout)} — v QR kódu max {formatCZK(11400)}, zbytek {formatCZK(selectedSummary.payout - 11400)} doplat zvlášť
                        </p>
                      )}
                    </div>
                  )}
                  {isApproved && !selectedSummary.worker.bank_account && (
                    <div className="bg-yellow-50 rounded-xl border border-yellow-200 p-4 text-center text-sm text-yellow-700">
                      Brigádník nemá zadaný bankovní účet — QR kód nelze vygenerovat.
                      <a href="/users" className="underline ml-1">Doplnit ve správě uživatelů</a>
                    </div>
                  )}

                  {/* Timesheet rows table */}
                  <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
                      <h4 className="text-sm font-semibold text-gray-700">Vykázané směny</h4>
                      {!isApproved && (
                        <button
                          onClick={() => setShowAddRow(!showAddRow)}
                          className="text-xs px-3 py-1 bg-orange-100 text-orange-700 rounded-lg hover:bg-orange-200"
                        >
                          {showAddRow ? 'Zrušit' : '+ Přidat řádek'}
                        </button>
                      )}
                    </div>

                    {/* Add row form */}
                    {showAddRow && (
                      <div className="px-5 py-3 bg-orange-50 border-b border-orange-100 flex flex-wrap items-end gap-3">
                        <div>
                          <label className="text-xs text-gray-500">Datum</label>
                          <input
                            type="date"
                            value={newRow.date}
                            onChange={e => setNewRow(p => ({ ...p, date: e.target.value }))}
                            className="block mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Od</label>
                          <input
                            type="time"
                            value={newRow.start}
                            onChange={e => setNewRow(p => ({ ...p, start: e.target.value }))}
                            className="block mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div>
                          <label className="text-xs text-gray-500">Do</label>
                          <input
                            type="time"
                            value={newRow.end}
                            onChange={e => setNewRow(p => ({ ...p, end: e.target.value }))}
                            className="block mt-1 px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                          />
                        </div>
                        <div className="flex-1 min-w-[120px]">
                          <label className="text-xs text-gray-500">Poznámka</label>
                          <input
                            type="text"
                            placeholder="Volitelné…"
                            value={newRow.note}
                            onChange={e => setNewRow(p => ({ ...p, note: e.target.value }))}
                            className="block mt-1 w-full px-2 py-1.5 text-sm border border-gray-300 rounded-lg"
                          />
                        </div>
                        <button
                          onClick={addAdminRow}
                          disabled={saving || !newRow.date || !newRow.start || !newRow.end}
                          className="px-4 py-1.5 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50"
                        >
                          Přidat
                        </button>
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
                            const isAdmin = row.source === 'admin' || !!row.added_by_admin
                            return (
                              <tr
                                key={row.id}
                                className={`border-b border-gray-50 ${
                                  isRejected ? 'bg-red-50/50' : isAdmin ? 'bg-blue-50/30' : ''
                                }`}
                              >
                                <td className={`px-5 py-2.5 ${isRejected ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                                  {formatDate(row.work_date)}
                                </td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : ''}`}>
                                  {row.admin_start || row.actual_start}
                                  {row.admin_start && row.admin_start !== row.actual_start && (
                                    <span className="block text-xs text-gray-300 line-through">{row.actual_start}</span>
                                  )}
                                </td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : ''}`}>
                                  {row.admin_end || row.actual_end}
                                  {row.admin_end && row.admin_end !== row.actual_end && (
                                    <span className="block text-xs text-gray-300 line-through">{row.actual_end}</span>
                                  )}
                                </td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : 'font-medium'}`}>
                                  {row.admin_start
                                    ? calcHours(row.admin_start, row.admin_end || row.actual_end).toFixed(1)
                                    : row.hours_worked.toFixed(1)
                                  }
                                </td>
                                <td className={`px-3 py-2.5 ${isRejected ? 'line-through text-gray-400' : ''}`}>
                                  {row.admin_night !== null ? row.admin_night.toFixed(1) : (row.night_hours || 0).toFixed(1)}
                                </td>
                                <td className="px-3 py-2.5">
                                  {isAdmin ? (
                                    <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-600 rounded">admin</span>
                                  ) : (
                                    <span className="text-xs text-gray-400">{row.source || 'brigádník'}</span>
                                  )}
                                  {row.admin_note && (
                                    <span className="block text-xs text-gray-400 italic mt-0.5">{row.admin_note}</span>
                                  )}
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  {!isApproved && (
                                    <button
                                      onClick={() => toggleReject(row.id, isRejected)}
                                      disabled={saving}
                                      className={`text-xs px-2 py-1 rounded ${
                                        isRejected
                                          ? 'bg-green-100 text-green-600 hover:bg-green-200'
                                          : 'bg-red-100 text-red-600 hover:bg-red-200'
                                      } disabled:opacity-50`}
                                    >
                                      {isRejected ? 'Obnovit' : 'Neschválit'}
                                    </button>
                                  )}
                                  {isApproved && isRejected && (
                                    <span className="text-xs text-red-400">Neschváleno</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                          {detailRows.length === 0 && (
                            <tr>
                              <td colSpan={7} className="px-5 py-8 text-center text-gray-400">
                                Žádné vykázané směny
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>

                    {/* Bottom add row button */}
                    {!isApproved && !showAddRow && (
                      <div className="px-5 py-3 border-t border-gray-100">
                        <button
                          onClick={() => setShowAddRow(true)}
                          className="text-xs text-orange-500 hover:text-orange-700"
                        >
                          + Přidat řádek ručně
                        </button>
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
