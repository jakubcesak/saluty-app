'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

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
  admin_start: string | null
  admin_end: string | null
  admin_night: number | null
}

export default function ApprovePage() {
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [workers, setWorkers] = useState<Worker[]>([])
  const [summaries, setSummaries] = useState<MonthSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedWorker, setSelectedWorker] = useState<string | null>(null)
  const [detailRows, setDetailRows] = useState<TimesheetRow[]>([])
  const [adjustments, setAdjustments] = useState<Record<string, { bonus: string; consumption: string; penalty: string }>>({})
  const [monthDate, setMonthDate] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })

  const monthStart = new Date(monthDate.year, monthDate.month, 1).toISOString().split('T')[0]
  const monthEnd = new Date(monthDate.year, monthDate.month + 1, 0).toISOString().split('T')[0]
  const monthLabel = new Date(monthDate.year, monthDate.month, 1).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { window.location.href = '/login'; return }
      setCurrentUser(user)
      const { data: w } = await supabase.from('users').select('*').is('deleted_at', null).eq('is_active', true).order('name')
      if (w) setWorkers(w)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!loading) loadSummaries()
  }, [monthDate, loading])

  const loadSummaries = async () => {
    const sums: MonthSummary[] = []

    for (const worker of workers) {
      const { data: ts } = await supabase.from('timesheets').select('*')
        .eq('user_id', worker.id)
        .gte('work_date', monthStart).lte('work_date', monthEnd)
        .is('deleted_at', null)

      if (!ts || ts.length === 0) continue

      let totalHours = 0
      let nightHours = 0
      ts.forEach(t => {
        totalHours += t.hours_worked || 0
        nightHours += t.night_hours || 0
      })

      const regularHours = totalHours - nightHours
      const wage = (regularHours * worker.hourly_rate) + (nightHours * worker.hourly_rate * 2)

      // Load tips
      let tips = 0
      const { data: shiftsInMonth } = await supabase.from('shifts').select('id')
        .gte('shift_date', monthStart).lte('shift_date', monthEnd).is('deleted_at', null)

      if (shiftsInMonth) {
        const shiftIds = shiftsInMonth.map(s => s.id)
        if (shiftIds.length > 0) {
          const { data: tipsData } = await supabase.from('daily_tips').select('*').in('shift_id', shiftIds)
          if (tipsData) {
            for (const tip of tipsData) {
              const { data: slotsForShift } = await supabase.from('shift_slots').select('id').eq('shift_id', tip.shift_id)
              if (!slotsForShift) continue
              const slotIds = slotsForShift.map(s => s.id)
              if (slotIds.length === 0) continue
              const { data: signupsForShift } = await supabase.from('shift_signups').select('user_id')
                .in('slot_id', slotIds).eq('status', 'confirmed')
              if (!signupsForShift) continue
              const uniqueWorkers = new Set(signupsForShift.map(s => s.user_id))
              if (uniqueWorkers.has(worker.id)) {
                tips += Math.round(tip.total_tips / uniqueWorkers.size)
              }
            }
          }
        }
      }

      // Load adjustments from monthly_reports
      const { data: report } = await supabase.from('monthly_reports').select('*')
        .eq('user_id', worker.id)
        .eq('month', monthStart)
        .single()

      const bonus = report?.bonus || 0
      const consumption = report?.consumption || 0
      const penalty = report?.penalty || 0

      const status = ts.every(t => t.status === 'approved') ? 'approved' :
        ts.some(t => t.status === 'submitted') ? 'submitted' : 'draft'

      const payout = Math.round(wage + tips + bonus - consumption - penalty)

      sums.push({
        worker,
        totalHours: Math.round(totalHours * 10) / 10,
        nightHours: Math.round(nightHours * 10) / 10,
        wage: Math.round(wage),
        tips,
        bonus,
        consumption,
        penalty,
        payout,
        status,
        timesheetIds: ts.map(t => t.id),
      })

      setAdjustments(prev => ({
        ...prev,
        [worker.id]: {
          bonus: String(bonus),
          consumption: String(consumption),
          penalty: String(penalty),
        }
      }))
    }

    setSummaries(sums)
  }

  const loadDetail = async (workerId: string) => {
    setSelectedWorker(workerId)

    const { data: ts } = await supabase.from('timesheets').select('*')
      .eq('user_id', workerId)
      .gte('work_date', monthStart).lte('work_date', monthEnd)
      .is('deleted_at', null)
      .order('work_date')

    if (ts) {
      setDetailRows(ts.map(t => ({
        ...t,
        actual_start: t.actual_start?.slice(0, 5) || '',
        actual_end: t.actual_end?.slice(0, 5) || '',
        admin_start: null,
        admin_end: null,
        admin_night: null,
      })))
    }
  }

  const updateDetailRow = (id: string, field: string, value: any) => {
    setDetailRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r))
  }

  const timeToMinutes = (t: string) => {
    if (!t) return 0
    const [h, m] = t.split(':').map(Number)
    return h * 60 + m
  }

  const calcHours = (start: string, end: string) => {
    if (!start || !end) return 0
    const s = timeToMinutes(start)
    let e = timeToMinutes(end)
    if (end === '23:59') e = 24 * 60
    if (e <= s) e += 24 * 60
    return Math.round(((e - s) / 60) * 10) / 10
  }

  const getEffectiveHours = (row: TimesheetRow) => {
    const start = row.admin_start || row.actual_start
    const end = row.admin_end || row.actual_end
    const night = row.admin_night !== null ? row.admin_night : row.night_hours
    return calcHours(start, end) + night
  }

  const handleSaveAdjustments = async (workerId: string) => {
    setSaving(true)
    const adj = adjustments[workerId]
    if (!adj) return

    const { data: existing } = await supabase.from('monthly_reports').select('id')
      .eq('user_id', workerId).eq('month', monthStart).single()

    const sum = summaries.find(s => s.worker.id === workerId)
    const data = {
      user_id: workerId,
      month: monthStart,
      total_hours: sum?.totalHours || 0,
      manual_hours: 0,
      hourly_rate: sum?.worker.hourly_rate || 0,
      wage_total: sum?.wage || 0,
      tips_total: sum?.tips || 0,
      bonus: parseFloat(adj.bonus) || 0,
      consumption: parseFloat(adj.consumption) || 0,
      penalty: parseFloat(adj.penalty) || 0,
      payout_total: 0,
      status: 'draft',
    }
    data.payout_total = Math.round(data.wage_total + data.tips_total + data.bonus - data.consumption - data.penalty)

    if (existing) {
      await supabase.from('monthly_reports').update(data).eq('id', existing.id)
    } else {
      await supabase.from('monthly_reports').insert(data)
    }

    await loadSummaries()
    setSaving(false)
    setMessage('Uloženo.')
  }

  const handleApprove = async (workerId: string) => {
    if (!confirm('Schválit timesheet tohoto brigádníka?')) return
    setSaving(true)

    const sum = summaries.find(s => s.worker.id === workerId)
    if (!sum) return

    // Save admin edits to timesheets
    for (const row of detailRows) {
      const updates: any = {}
      if (row.admin_start) updates.actual_start = row.admin_start
      if (row.admin_end) updates.actual_end = row.admin_end
      if (row.admin_night !== null) updates.night_hours = row.admin_night
      updates.status = 'approved'
      updates.hours_worked = getEffectiveHours(row)
      await supabase.from('timesheets').update(updates).eq('id', row.id)
    }

    // Update monthly report
    const adj = adjustments[workerId] || { bonus: '0', consumption: '0', penalty: '0' }
    const { data: existing } = await supabase.from('monthly_reports').select('id')
      .eq('user_id', workerId).eq('month', monthStart).single()

    const reportData = {
      user_id: workerId,
      month: monthStart,
      total_hours: sum.totalHours,
      manual_hours: 0,
      hourly_rate: sum.worker.hourly_rate,
      wage_total: sum.wage,
      tips_total: sum.tips,
      bonus: parseFloat(adj.bonus) || 0,
      consumption: parseFloat(adj.consumption) || 0,
      penalty: parseFloat(adj.penalty) || 0,
      payout_total: 0,
      status: 'approved_by_admin',
      approved_by: currentUser.id,
      approved_at: new Date().toISOString(),
    }
    reportData.payout_total = Math.round(reportData.wage_total + reportData.tips_total + reportData.bonus - (reportData.consumption || 0) - (reportData.penalty || 0))

    if (existing) {
      await supabase.from('monthly_reports').update(reportData).eq('id', existing.id)
    } else {
      await supabase.from('monthly_reports').insert(reportData)
    }

    await loadSummaries()
    if (selectedWorker === workerId) await loadDetail(workerId)
    setSaving(false)
    setMessage('Timesheet schválen.')
  }

  const handleReopen = async (workerId: string) => {
    if (!confirm('Znovu otevřít timesheet k editaci?')) return
    setSaving(true)

    const sum = summaries.find(s => s.worker.id === workerId)
    if (!sum) return

    for (const tsId of sum.timesheetIds) {
      await supabase.from('timesheets').update({ status: 'submitted' }).eq('id', tsId)
    }

    await supabase.from('monthly_reports').update({ status: 'draft' })
      .eq('user_id', workerId).eq('month', monthStart)

    await loadSummaries()
    if (selectedWorker === workerId) await loadDetail(workerId)
    setSaving(false)
  }

  const changeMonth = (dir: number) => {
    setSelectedWorker(null)
    setMonthDate(prev => {
      const d = new Date(prev.year, prev.month + dir, 1)
      return { year: d.getFullYear(), month: d.getMonth() }
    })
  }

  const fmtDate = (d: string) => {
    const dt = new Date(d)
    const names = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So']
    return `${names[dt.getDay()]} ${dt.getDate()}.${dt.getMonth() + 1}.`
  }

  const generateQrData = (sum: MonthSummary) => {
    const account = sum.worker.bank_account || ''
    const parts = account.split('/')
    if (parts.length !== 2) return null

    const accountNum = parts[0]
    const bankCode = parts[1]
    const iban = `CZ00${bankCode}${'0'.repeat(16 - accountNum.length)}${accountNum}`
    const amount = Math.min(sum.payout, 11400)
    const msg = `Mzda ${monthLabel} ${sum.worker.name}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

    return `SPD*1.0*ACC:${iban}*AM:${amount}.00*CC:CZK*MSG:${msg}*`
  }

  const selectedSummary = summaries.find(s => s.worker.id === selectedWorker)

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Načítám...</p></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-4">
            <a href="/" className="text-lg font-bold text-gray-900">Saluti</a>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">Schvalování timesheetů</span>
          </div>
          <span className="text-sm text-gray-500">{currentUser?.email}</span>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Month nav */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => changeMonth(-1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&larr;</button>
          <span className="text-base font-semibold text-gray-900 capitalize">{monthLabel}</span>
          <button onClick={() => changeMonth(1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&rarr;</button>
        </div>

        {message && (
          <div className="mb-4 px-4 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">{message}</div>
        )}

        {/* Workers summary table */}
        {summaries.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
            <p className="text-gray-500">V tomto měsíci nejsou žádné timesheety.</p>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden mb-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Brigádník</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Hodiny</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Noční</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Sazba</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Mzda</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">Dýška</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500">K výplatě</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-500">Status</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {summaries.map(sum => {
                    const isSelected = selectedWorker === sum.worker.id
                    return (
                      <tr key={sum.worker.id}
                        className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 ${isSelected ? 'bg-orange-50' : ''}`}
                        onClick={() => isSelected ? setSelectedWorker(null) : loadDetail(sum.worker.id)}
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">{sum.worker.name}</div>
                          <div className="text-xs text-gray-500">{sum.worker.email}</div>
                        </td>
                        <td className="px-4 py-3 text-right text-gray-900">{sum.totalHours} h</td>
                        <td className="px-4 py-3 text-right text-orange-600">{sum.nightHours > 0 ? `${sum.nightHours} h` : '–'}</td>
                        <td className="px-4 py-3 text-right text-gray-500">{sum.worker.hourly_rate} Kč</td>
                        <td className="px-4 py-3 text-right text-gray-900">{sum.wage.toLocaleString('cs-CZ')} Kč</td>
                        <td className="px-4 py-3 text-right text-gray-900">{sum.tips > 0 ? `${sum.tips.toLocaleString('cs-CZ')} Kč` : '–'}</td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">{sum.payout.toLocaleString('cs-CZ')} Kč</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`text-xs px-2 py-1 rounded ${
                            sum.status === 'approved' ? 'bg-green-100 text-green-700' :
                            sum.status === 'submitted' ? 'bg-blue-100 text-blue-700' :
                            'bg-gray-100 text-gray-600'
                          }`}>
                            {sum.status === 'approved' ? 'Schváleno' :
                             sum.status === 'submitted' ? 'Ke schválení' : 'Rozpracováno'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-gray-400">{isSelected ? '▲' : '▼'}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Detail panel */}
        {selectedWorker && selectedSummary && (
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="font-semibold text-gray-900 mb-4">
              Detail — {selectedSummary.worker.name}, {monthLabel}
            </h3>

            {/* Detail timesheet rows */}
            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Den</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Příchod</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Odchod</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Noční</th>
                    <th className="text-left px-3 py-2 font-medium text-gray-500">Admin korekce</th>
                    <th className="text-right px-3 py-2 font-medium text-gray-500">Hodiny</th>
                    <th className="text-center px-3 py-2 font-medium text-gray-500">Zdroj</th>
                  </tr>
                </thead>
                <tbody>
                  {detailRows.map(row => {
                    const hasAdminEdit = row.admin_start || row.admin_end || row.admin_night !== null
                    const effectiveHours = getEffectiveHours(row)

                    return (
                      <tr key={row.id} className="border-b border-gray-100">
                        <td className="px-3 py-2 font-medium text-gray-900">{fmtDate(row.work_date)}</td>
                        <td className="px-3 py-2">
                          <div className={`${row.admin_start ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                            {row.actual_start}
                          </div>
                          {selectedSummary.status !== 'approved' && (
                            <input type="time" value={row.admin_start || ''}
                              onChange={(e) => updateDetailRow(row.id, 'admin_start', e.target.value || null)}
                              placeholder="Korekce"
                              className="w-full mt-1 px-1 py-0.5 border border-orange-200 rounded text-xs text-orange-700" />
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className={`${row.admin_end ? 'line-through text-gray-400' : 'text-gray-900'}`}>
                            {row.actual_end}
                          </div>
                          {selectedSummary.status !== 'approved' && (
                            <input type="time" value={row.admin_end || ''}
                              onChange={(e) => updateDetailRow(row.id, 'admin_end', e.target.value || null)}
                              placeholder="Korekce"
                              className="w-full mt-1 px-1 py-0.5 border border-orange-200 rounded text-xs text-orange-700" />
                          )}
                        </td>
                        <td className="px-3 py-2 text-orange-600">
                          {row.night_hours > 0 ? `${row.night_hours} h` : '–'}
                        </td>
                        <td className="px-3 py-2">
                          {hasAdminEdit && (
                            <span className="text-xs text-orange-600">
                              {row.admin_start && `Příchod: ${row.admin_start}`}
                              {row.admin_end && ` Odchod: ${row.admin_end}`}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-gray-900">{effectiveHours.toFixed(1)} h</td>
                        <td className="px-3 py-2 text-center">
                          <span className={`text-xs px-2 py-1 rounded ${
                            row.source === 'manual' ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600'
                          }`}>{row.source === 'manual' ? 'Ručně' : 'Směna'}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Adjustments */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div>
                <label className="block text-sm text-gray-600 mb-1">Mimořádná odměna (Kč)</label>
                <input type="number" value={adjustments[selectedWorker]?.bonus || '0'}
                  onChange={(e) => setAdjustments(prev => ({ ...prev, [selectedWorker!]: { ...prev[selectedWorker!], bonus: e.target.value } }))}
                  disabled={selectedSummary.status === 'approved'}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Spotřeba — odečíst (Kč)</label>
                <input type="number" value={adjustments[selectedWorker]?.consumption || '0'}
                  onChange={(e) => setAdjustments(prev => ({ ...prev, [selectedWorker!]: { ...prev[selectedWorker!], consumption: e.target.value } }))}
                  disabled={selectedSummary.status === 'approved'}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100" />
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Pokuta — odečíst (Kč)</label>
                <input type="number" value={adjustments[selectedWorker]?.penalty || '0'}
                  onChange={(e) => setAdjustments(prev => ({ ...prev, [selectedWorker!]: { ...prev[selectedWorker!], penalty: e.target.value } }))}
                  disabled={selectedSummary.status === 'approved'}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm disabled:bg-gray-100" />
              </div>
            </div>

            {/* Payout summary */}
            <div className="border border-gray-200 rounded-lg overflow-hidden mb-6">
              <table className="w-full text-sm">
                <tbody>
                  <tr><td className="px-4 py-2 text-gray-600">Mzda</td><td className="px-4 py-2 text-right">{selectedSummary.wage.toLocaleString('cs-CZ')} Kč</td></tr>
                  <tr className="border-t border-gray-100"><td className="px-4 py-2 text-gray-600">Dýška</td><td className="px-4 py-2 text-right">{selectedSummary.tips.toLocaleString('cs-CZ')} Kč</td></tr>
                  {parseFloat(adjustments[selectedWorker]?.bonus || '0') > 0 && (
                    <tr className="border-t border-gray-100"><td className="px-4 py-2 text-green-600">+ Odměna</td><td className="px-4 py-2 text-right text-green-600">{parseFloat(adjustments[selectedWorker]?.bonus || '0').toLocaleString('cs-CZ')} Kč</td></tr>
                  )}
                  {parseFloat(adjustments[selectedWorker]?.consumption || '0') > 0 && (
                    <tr className="border-t border-gray-100"><td className="px-4 py-2 text-red-600">− Spotřeba</td><td className="px-4 py-2 text-right text-red-600">{parseFloat(adjustments[selectedWorker]?.consumption || '0').toLocaleString('cs-CZ')} Kč</td></tr>
                  )}
                  {parseFloat(adjustments[selectedWorker]?.penalty || '0') > 0 && (
                    <tr className="border-t border-gray-100"><td className="px-4 py-2 text-red-600">− Pokuta</td><td className="px-4 py-2 text-right text-red-600">{parseFloat(adjustments[selectedWorker]?.penalty || '0').toLocaleString('cs-CZ')} Kč</td></tr>
                  )}
                  <tr className="border-t-2 border-gray-300 bg-gray-50">
                    <td className="px-4 py-3 font-semibold text-gray-900">K výplatě</td>
                    <td className="px-4 py-3 text-right font-semibold text-lg text-gray-900">{selectedSummary.payout.toLocaleString('cs-CZ')} Kč</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* QR code for approved */}
            {selectedSummary.status === 'approved' && selectedSummary.worker.bank_account && (
              <div className="border border-gray-200 rounded-lg p-4 mb-6">
                <div className="flex gap-6 items-start">
                  <div>
                    <div className="text-sm font-medium text-gray-900 mb-2">Platba převodem</div>
                    <div className="text-sm text-gray-600">
                      Účet: <strong>{selectedSummary.worker.bank_account}</strong><br />
                      Částka: <strong>{Math.min(selectedSummary.payout, 11400).toLocaleString('cs-CZ')} Kč</strong>
                      {selectedSummary.payout > 11400 && <span className="text-xs text-orange-600 ml-1">(max 11 400 Kč v QR)</span>}<br />
                      Zpráva: <strong>Mzda {monthLabel} {selectedSummary.worker.name}</strong>
                    </div>
                  </div>
                  <div className="text-center">
                    <div className="text-xs text-gray-500 mb-2">QR platba</div>
                    <div id={`qr-${selectedSummary.worker.id}`} className="w-32 h-32 border border-gray-200 rounded flex items-center justify-center">
                      <QrCode data={generateQrData(selectedSummary)} />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              {selectedSummary.status !== 'approved' && (
                <>
                  <button onClick={() => handleSaveAdjustments(selectedWorker!)} disabled={saving}
                    className="px-5 py-2 bg-white border border-gray-300 text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50">
                    Uložit změny
                  </button>
                  <button onClick={() => handleApprove(selectedWorker!)} disabled={saving}
                    className="px-5 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 disabled:opacity-50">
                    Schválit timesheet
                  </button>
                </>
              )}
              {selectedSummary.status === 'approved' && (
                <button onClick={() => handleReopen(selectedWorker!)} disabled={saving}
                  className="px-5 py-2 bg-white border border-orange-300 text-orange-600 text-sm rounded-lg hover:bg-orange-50 disabled:opacity-50">
                  Znovu otevřít k editaci
                </button>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function QrCode({ data }: { data: string | null }) {
  const [loaded, setLoaded] = useState(false)
  const ref = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!data) return
    const script = document.createElement('script')
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
    script.onload = () => setLoaded(true)
    document.head.appendChild(script)
  }, [data])

  useEffect(() => {
    if (!loaded || !data) return
    const el = document.getElementById('qr-render')
    if (el) {
      el.innerHTML = ''
      new (window as any).QRCode(el, {
        text: data,
        width: 120,
        height: 120,
        correctLevel: (window as any).QRCode.CorrectLevel.M,
      })
    }
  }, [loaded, data])

  if (!data) return <span className="text-xs text-gray-400">Chybí účet</span>

  return <div id="qr-render"></div>
}