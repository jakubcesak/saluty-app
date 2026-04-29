'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

type Shift = { id: string; shift_date: string }
type ShiftSlot = { id: string; shift_id: string; slot_start: string; slot_end: string }
type ShiftSignup = { id: string; slot_id: string; user_id: string }

type Row = {
  key: string
  date: string
  shiftId: string | null
  plannedStart: string
  plannedEnd: string
  actualStart: string
  actualEnd: string
  nightMinutes: number
  source: 'shift' | 'manual'
  timesheetId: string | null
  status: string
}

const TIME_OPTIONS: string[] = []
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 15) {
    TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
}
TIME_OPTIONS.push('23:59')

const NIGHT_OPTIONS = [
  { value: 0, label: '–' },
  { value: 15, label: '+15 min' },
  { value: 30, label: '+30 min' },
  { value: 45, label: '+45 min' },
  { value: 60, label: '+1 hod' },
  { value: 75, label: '+1:15' },
  { value: 90, label: '+1:30' },
  { value: 105, label: '+1:45' },
  { value: 120, label: '+2 hod' },
  { value: 135, label: '+2:15' },
  { value: 150, label: '+2:30' },
  { value: 165, label: '+2:45' },
  { value: 180, label: '+3 hod' },
  { value: 195, label: '+3:15' },
  { value: 210, label: '+3:30' },
  { value: 225, label: '+3:45' },
  { value: 240, label: '+4 hod' },
]

export default function TimesheetPage() {
  const [user, setUser] = useState<any>(null)
  const [dbUser, setDbUser] = useState<any>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [monthDate, setMonthDate] = useState(() => {
    const d = new Date()
    return { year: d.getFullYear(), month: d.getMonth() }
  })

  const monthStart = new Date(monthDate.year, monthDate.month, 1).toISOString().split('T')[0]
  const monthEnd = new Date(monthDate.year, monthDate.month + 1, 0).toISOString().split('T')[0]
  const monthLabel = new Date(monthDate.year, monthDate.month, 1).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' })

  // Check if month is locked (approved)
  const isLocked = rows.length > 0 && rows.every(r => r.status === 'approved')

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { window.location.href = '/login'; return }
      setUser(user)
      const { data: du } = await supabase.from('users').select('*').eq('id', user.id).single()
      setDbUser(du)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!loading && user) loadData()
  }, [monthDate, loading])

  const loadData = async () => {
    // Load existing timesheets
    const { data: tsData } = await supabase.from('timesheets').select('*')
      .eq('user_id', user.id)
      .gte('work_date', monthStart).lte('work_date', monthEnd)
      .is('deleted_at', null)
      .order('work_date')

    const timesheets = tsData || []

    const newRows: Row[] = timesheets.map(ts => ({
      key: `ts-${ts.id}`,
      date: ts.work_date,
      shiftId: ts.shift_id,
      plannedStart: '',
      plannedEnd: '',
      actualStart: ts.actual_start?.slice(0, 5) || '',
      actualEnd: ts.actual_end?.slice(0, 5) || '',
      nightMinutes: Math.round((ts.night_hours || 0) * 60),
      source: ts.source as 'shift' | 'manual',
      timesheetId: ts.id,
      status: ts.status,
    }))

    // Enrich with planned times from shifts
    for (const row of newRows) {
      if (row.shiftId) {
        const { data: slotsData } = await supabase.from('shift_slots').select('*')
          .eq('shift_id', row.shiftId).is('deleted_at', null)
        if (slotsData && slotsData.length > 0) {
          const mySlots = []
          for (const slot of slotsData) {
            const { data: sg } = await supabase.from('shift_signups').select('id')
              .eq('slot_id', slot.id).eq('user_id', user.id).eq('status', 'confirmed')
            if (sg && sg.length > 0) mySlots.push(slot)
          }
          if (mySlots.length > 0) {
            mySlots.sort((a, b) => a.slot_start.localeCompare(b.slot_start))
            row.plannedStart = mySlots[0].slot_start.slice(0, 5)
            row.plannedEnd = mySlots[mySlots.length - 1].slot_end.slice(0, 5)
          }
        }
      }
    }

    setRows(newRows)
  }

  const prefillFromShifts = async () => {
    setMessage('')
    // Find all my shifts in this month
    const { data: shiftsData } = await supabase.from('shifts').select('*')
      .gte('shift_date', monthStart).lte('shift_date', monthEnd)
      .is('deleted_at', null)

    if (!shiftsData || shiftsData.length === 0) { setMessage('V tomto měsíci nemáte žádné směny.'); return }

    const shiftIds = shiftsData.map(s => s.id)
    const { data: slotsData } = await supabase.from('shift_slots').select('*')
      .in('shift_id', shiftIds).is('deleted_at', null)
    if (!slotsData) return

    const slotIds = slotsData.map(s => s.id)
    const { data: signupsData } = await supabase.from('shift_signups').select('*')
      .in('slot_id', slotIds).eq('user_id', user.id).eq('status', 'confirmed')
    if (!signupsData) return

    let added = 0
    const currentRows = [...rows]

    for (const signup of signupsData) {
      const slot = slotsData.find(s => s.id === signup.slot_id)
      if (!slot) continue
      const shift = shiftsData.find(s => s.id === slot.shift_id)
      if (!shift) continue

      // Check if already exists
      const exists = currentRows.find(r =>
        r.shiftId === shift.id && r.source === 'shift' &&
        r.plannedStart === slot.slot_start.slice(0, 5) &&
        r.plannedEnd === slot.slot_end.slice(0, 5)
      )
      if (exists) continue

      // Also check by date + time match
      const dateExists = currentRows.find(r =>
        r.date === shift.shift_date &&
        r.actualStart === slot.slot_start.slice(0, 5) &&
        r.actualEnd === slot.slot_end.slice(0, 5)
      )
      if (dateExists) continue

      const newRow: Row = {
        key: `prefill-${Date.now()}-${added}`,
        date: shift.shift_date,
        shiftId: shift.id,
        plannedStart: slot.slot_start.slice(0, 5),
        plannedEnd: slot.slot_end.slice(0, 5),
        actualStart: slot.slot_start.slice(0, 5),
        actualEnd: slot.slot_end.slice(0, 5),
        nightMinutes: 0,
        source: 'shift',
        timesheetId: null,
        status: 'draft',
      }
      currentRows.push(newRow)
      added++
    }

    currentRows.sort((a, b) => a.date.localeCompare(b.date))
    setRows(currentRows)
    setMessage(added > 0 ? `Přidáno ${added} řádků ze směn.` : 'Všechny směny jsou již zadané.')
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

  const updateRow = (key: string, field: keyof Row, value: any) => {
    setRows(prev => prev.map(r => r.key === key ? { ...r, [field]: value } : r))
  }

  const addManualRow = () => {
    const today = new Date().toISOString().split('T')[0]
    setRows(prev => [...prev, {
      key: `manual-${Date.now()}`,
      date: today,
      shiftId: null,
      plannedStart: '',
      plannedEnd: '',
      actualStart: '08:00',
      actualEnd: '16:00',
      nightMinutes: 0,
      source: 'manual' as const,
      timesheetId: null,
      status: 'draft',
    }].sort((a, b) => a.date.localeCompare(b.date)))
  }

  const deleteRow = async (row: Row) => {
    if (!confirm('Smazat tento řádek?')) return
    if (row.timesheetId) {
      await supabase.from('timesheets').update({ deleted_at: new Date().toISOString() }).eq('id', row.timesheetId)
    }
    setRows(prev => prev.filter(r => r.key !== row.key))
  }

  const hasDuplicitDay = (date: string) => {
    return rows.filter(r => r.date === date).length > 1
  }

  const handleSave = async () => {
    if (!user) return
    setSaving(true)
    setMessage('')

    const savedIds: string[] = []

    for (const row of rows) {
      const hours = calcHours(row.actualStart, row.actualEnd)
      const nightHours = row.nightMinutes / 60
      const totalHours = hours + nightHours
      if (totalHours === 0 && !row.timesheetId) continue

      const data = {
        user_id: user.id,
        shift_id: row.shiftId,
        work_date: row.date,
        actual_start: row.actualStart || '00:00',
        actual_end: row.actualEnd || '00:00',
        hours_worked: totalHours,
        night_hours: nightHours,
        source: row.source,
        status: row.status === 'approved' ? 'approved' : (row.status === 'submitted' ? 'submitted' : 'draft'),
      }

      if (row.timesheetId) {
        await supabase.from('timesheets').update(data).eq('id', row.timesheetId)
        savedIds.push(row.timesheetId)
      } else {
        const { data: inserted } = await supabase.from('timesheets').insert(data).select().single()
        if (inserted) savedIds.push(inserted.id)
      }
    }

    // Reload to get updated IDs, then sort
    await loadData()
    setSaving(false)
    setMessage('Změny uloženy.')
  }

  const handleSubmit = async () => {
    if (!confirm('Odeslat timesheet ke schválení? Po schválení ho nebude možné editovat.')) return
    setSaving(true)
    setMessage('')

    // First save everything
    for (const row of rows) {
      const hours = calcHours(row.actualStart, row.actualEnd)
      const nightHours = row.nightMinutes / 60
      const totalHours = hours + nightHours

      const data = {
        user_id: user.id,
        shift_id: row.shiftId,
        work_date: row.date,
        actual_start: row.actualStart || '00:00',
        actual_end: row.actualEnd || '00:00',
        hours_worked: totalHours,
        night_hours: nightHours,
        source: row.source,
        status: 'submitted',
      }

      if (row.timesheetId) {
        await supabase.from('timesheets').update(data).eq('id', row.timesheetId)
      } else {
        await supabase.from('timesheets').insert(data)
      }
    }

    await loadData()
    setSaving(false)
    setMessage('Timesheet odeslán ke schválení.')
  }

  const changeMonth = (dir: number) => {
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

  const hourlyRate = dbUser?.hourly_rate || 0
  const totalHours = rows.reduce((s, r) => s + calcHours(r.actualStart, r.actualEnd), 0)
  const totalNight = rows.reduce((s, r) => s + r.nightMinutes / 60, 0)
  const totalWage = (totalHours * hourlyRate) + (totalNight * hourlyRate * 2)
  const statusLabel = rows.length === 0 ? '' :
    rows.every(r => r.status === 'approved') ? 'Schváleno' :
    rows.some(r => r.status === 'submitted') ? 'Ke schválení' : 'Rozpracováno'

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Načítám...</p></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-4">
            <a href="/" className="text-lg font-bold text-gray-900">Saluti</a>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">Timesheet</span>
          </div>
          <span className="text-sm text-gray-500">{dbUser?.name || user?.email}</span>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {/* Month nav */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button onClick={() => changeMonth(-1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&larr;</button>
            <span className="text-base font-semibold text-gray-900 capitalize">{monthLabel}</span>
            <button onClick={() => changeMonth(1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&rarr;</button>
            {statusLabel && (
              <span className={`text-xs px-2 py-1 rounded ${
                statusLabel === 'Schváleno' ? 'bg-green-100 text-green-700' :
                statusLabel === 'Ke schválení' ? 'bg-blue-100 text-blue-700' :
                'bg-gray-100 text-gray-600'
              }`}>{statusLabel}</span>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={prefillFromShifts} disabled={isLocked}
              className="text-sm px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              Předvyplnit ze směn
            </button>
            <button onClick={addManualRow} disabled={isLocked}
              className="text-sm px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              + Ruční řádek
            </button>
          </div>
        </div>

        {message && (
          <div className="mb-4 px-4 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">{message}</div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs text-gray-500">Hodiny</div>
            <div className="text-lg font-semibold text-gray-900">{totalHours.toFixed(1)} h</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs text-gray-500">Po půlnoci (2×)</div>
            <div className="text-lg font-semibold text-orange-600">{totalNight.toFixed(1)} h</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs text-gray-500">Sazba</div>
            <div className="text-lg font-semibold text-gray-900">{hourlyRate} Kč/h</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs text-gray-500">Mzda</div>
            <div className="text-lg font-semibold text-gray-900">{Math.round(totalWage).toLocaleString('cs-CZ')} Kč</div>
          </div>
        </div>

        {/* Table */}
        {rows.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
            <p className="text-gray-500 mb-4">Zatím nemáte žádné záznamy.</p>
            <div className="flex gap-3 justify-center">
              <button onClick={prefillFromShifts} className="text-sm text-orange-600 hover:text-orange-700">Předvyplnit ze směn</button>
              <button onClick={addManualRow} className="text-sm text-orange-600 hover:text-orange-700">Přidat ručně</button>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-3 py-3 font-medium text-gray-500 w-28">Den</th>
                    <th className="text-left px-3 py-3 font-medium text-gray-500 w-24">Plán</th>
                    <th className="text-left px-3 py-3 font-medium text-gray-500 w-28">Příchod</th>
                    <th className="text-left px-3 py-3 font-medium text-gray-500 w-28">Odchod</th>
                    <th className="text-left px-3 py-3 font-medium text-gray-500 w-28">Po půlnoci</th>
                    <th className="text-right px-3 py-3 font-medium text-gray-500 w-20">Hodiny</th>
                    <th className="text-center px-3 py-3 font-medium text-gray-500 w-24">Zdroj</th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const hours = calcHours(row.actualStart, row.actualEnd)
                    const nightH = row.nightMinutes / 60
                    const total = hours + nightH
                    const isManual = row.source === 'manual'
                    const isDuplicit = hasDuplicitDay(row.date)
                    const locked = row.status === 'approved'

                    return (
                      <tr key={row.key} className={`border-b border-gray-100 ${isManual ? 'bg-yellow-50/30' : ''}`}>
                        <td className="px-3 py-2">
                          {isManual && !locked ? (
                            <input type="date" value={row.date}
                              onChange={(e) => updateRow(row.key, 'date', e.target.value)}
                              className="w-full px-2 py-1 border border-gray-300 rounded text-sm" />
                          ) : (
                            <span className="font-medium text-gray-900">{fmtDate(row.date)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-400 text-xs">
                          {row.plannedStart && row.plannedEnd ? `${row.plannedStart}–${row.plannedEnd}` : '–'}
                        </td>
                        <td className="px-3 py-2">
                          <select value={row.actualStart} disabled={locked}
                            onChange={(e) => updateRow(row.key, 'actualStart', e.target.value)}
                            className="w-full px-2 py-1 border border-gray-300 rounded text-sm disabled:bg-gray-100">
                            {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select value={row.actualEnd} disabled={locked}
                            onChange={(e) => updateRow(row.key, 'actualEnd', e.target.value)}
                            className="w-full px-2 py-1 border border-gray-300 rounded text-sm disabled:bg-gray-100">
                            {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select value={row.nightMinutes} disabled={locked}
                            onChange={(e) => updateRow(row.key, 'nightMinutes', parseInt(e.target.value))}
                            className={`w-full px-2 py-1 border border-gray-300 rounded text-sm disabled:bg-gray-100 ${row.nightMinutes > 0 ? 'text-orange-600 font-medium' : ''}`}>
                            {NIGHT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right font-medium text-gray-900">
                          {total > 0 ? `${total.toFixed(1)} h` : '–'}
                          {nightH > 0 && <div className="text-xs text-orange-600">+{nightH.toFixed(1)} noční</div>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <span className={`text-xs px-2 py-1 rounded ${
                              isManual ? 'bg-yellow-100 text-yellow-800' : 'bg-gray-100 text-gray-600'
                            }`}>{isManual ? 'Ručně' : 'Směna'}</span>
                            {isDuplicit && <span className="text-orange-500" title="Více záznamů ve stejný den">⚠️</span>}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-center">
                          {!locked && (
                            <button onClick={() => deleteRow(row)} className="text-gray-400 hover:text-red-500">✕</button>
                          )}
                        </td>
                      </tr>
                    )
                  })}

                  {/* Add row button at bottom */}
                  {!isLocked && (
                    <tr className="border-b border-gray-100">
                      <td colSpan={8} className="px-3 py-2">
                        <button onClick={addManualRow} className="text-sm text-blue-600 hover:text-blue-700">
                          + Přidat řádek ručně
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <span className="text-xs text-gray-500">
                {rows.length} řádků · {(totalHours + totalNight).toFixed(1)} h celkem
              </span>
              {!isLocked && (
                <div className="flex gap-2">
                  <button onClick={handleSave} disabled={saving}
                    className="px-5 py-2 bg-white border border-gray-300 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-50">
                    {saving ? 'Ukládám...' : 'Uložit změny'}
                  </button>
                  <button onClick={handleSubmit} disabled={saving}
                    className="px-5 py-2 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50">
                    {saving ? 'Odesílám...' : 'Odeslat ke schválení'}
                  </button>
                </div>
              )}
              {isLocked && (
                <span className="text-sm text-green-600 font-medium">Timesheet schválen — nelze editovat.</span>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 text-xs text-gray-500">
          <p><strong>Po půlnoci:</strong> Pokud pracuješ přes půlnoc, vyplň Odchod jako 23:59 a ve sloupci "Po půlnoci" vyber kolik hodin jsi ještě pracoval/a po půlnoci. Tyto hodiny mají dvojnásobnou sazbu.</p>
        </div>
      </main>
    </div>
  )
}