'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

type Shift = { id: string; shift_date: string; note: string | null }
type ShiftSlot = { id: string; shift_id: string; slot_start: string; slot_end: string; required_workers: number }
type ShiftSignup = { id: string; slot_id: string; user_id: string; status: string; user_name?: string }
type User = { id: string; name: string; email: string; role: string }

const TIME_OPTIONS: string[] = []
for (let h = 0; h < 24; h++) {
  for (let m = 0; m < 60; m += 15) {
    TIME_OPTIONS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
}
TIME_OPTIONS.push('23:59')

const SLOT_HEIGHT = 28
const SLOT_GAP = 2
const HOUR_WIDTH = 80
const LABEL_WIDTH = 120
const ACTIONS_WIDTH = 160
const HOURS_VISIBLE = 14

export default function ShiftsPage() {
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [slots, setSlots] = useState<ShiftSlot[]>([])
  const [signups, setSignups] = useState<ShiftSignup[]>([])
  const [workers, setWorkers] = useState<User[]>([])
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date()
    const day = d.getDay()
    const diff = d.getDate() - day + (day === 0 ? -6 : 1)
    const monday = new Date(d.setDate(diff))
    return monday.toISOString().split('T')[0]
  })
  const [loading, setLoading] = useState(true)
  const [editingSlot, setEditingSlot] = useState<{ date: string; slotId?: string; start: string; end: string; count: string; countMode: string } | null>(null)
  const [assigningSlot, setAssigningSlot] = useState<string | null>(null)
  const [tips, setTips] = useState<Record<string, { id?: string; amount: string }>>({})
  const [saving, setSaving] = useState(false)
  const [timelineStart, setTimelineStart] = useState(8)

  const weekDates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart)
    d.setDate(d.getDate() + i)
    return d.toISOString().split('T')[0]
  })

  const dayNames = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne']
  const timelineHours = Array.from({ length: HOURS_VISIBLE }, (_, i) => (timelineStart + i) % 24)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { window.location.href = '/login'; return }
      setCurrentUser(user)
      await loadWorkers()
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!loading) loadWeekData()
  }, [weekStart, loading])

  const loadWorkers = async () => {
    const { data } = await supabase.from('users').select('id, name, email, role')
      .is('deleted_at', null).eq('is_active', true).order('name')
    if (data) setWorkers(data)
  }

  const loadWeekData = async () => {
    const endDate = weekDates[6]
    const { data: shiftsData } = await supabase.from('shifts').select('*')
      .gte('shift_date', weekStart).lte('shift_date', endDate)
      .is('deleted_at', null).order('shift_date')

    if (!shiftsData) return
    setShifts(shiftsData)
    const shiftIds = shiftsData.map(s => s.id)

    if (shiftIds.length === 0) { setSlots([]); setSignups([]); setTips({}); return }

    const { data: slotsData } = await supabase.from('shift_slots').select('*')
      .in('shift_id', shiftIds).is('deleted_at', null).order('slot_start')
    if (!slotsData) { setSlots([]); setSignups([]); return }
    setSlots(slotsData)

    const slotIds = slotsData.map(s => s.id)
    if (slotIds.length > 0) {
      const { data: signupsData } = await supabase.from('shift_signups').select('*')
        .in('slot_id', slotIds).is('deleted_at', null).eq('status', 'confirmed')
      if (signupsData) {
        setSignups(signupsData.map(s => ({ ...s, user_name: workers.find(w => w.id === s.user_id)?.name || '?' })))
      }
    } else { setSignups([]) }

    const { data: tipsData } = await supabase.from('daily_tips').select('*').in('shift_id', shiftIds)
    if (tipsData) {
      const m: Record<string, { id: string; amount: string }> = {}
      tipsData.forEach(t => {
        const s = shiftsData.find(x => x.id === t.shift_id)
        if (s) m[s.shift_date] = { id: t.id, amount: String(t.total_tips) }
      })
      setTips(m)
    }
  }

  const getShiftForDate = (date: string) => shifts.find(s => s.shift_date === date)
  const getSlotsForShift = (shiftId: string) => slots.filter(s => s.shift_id === shiftId).sort((a, b) => a.slot_start.localeCompare(b.slot_start))
  const getSignupsForSlot = (slotId: string) => signups.filter(s => s.slot_id === slotId)

  const getWorkersOnDate = (date: string) => {
    const shift = getShiftForDate(date)
    if (!shift) return []
    const ids = new Set<string>()
    getSlotsForShift(shift.id).forEach(slot => getSignupsForSlot(slot.id).forEach(s => ids.add(s.user_id)))
    return Array.from(ids)
  }

  const isWorkerOverlapping = (userId: string, date: string) => {
    const shift = getShiftForDate(date)
    if (!shift) return false
    const dateSlots = getSlotsForShift(shift.id)

    const workerSlots = dateSlots.filter(slot =>
      getSignupsForSlot(slot.id).some(s => s.user_id === userId)
    )

    for (let i = 0; i < workerSlots.length; i++) {
      for (let j = i + 1; j < workerSlots.length; j++) {
        const aStart = timeToMinutes(workerSlots[i].slot_start)
        let aEnd = timeToMinutes(workerSlots[i].slot_end)
        if (aEnd <= aStart) aEnd += 24 * 60
        const bStart = timeToMinutes(workerSlots[j].slot_start)
        let bEnd = timeToMinutes(workerSlots[j].slot_end)
        if (bEnd <= bStart) bEnd += 24 * 60

        if (aStart < bEnd && bStart < aEnd) return true
      }
    }
    return false
  }

  const timeToMinutes = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }

  const getSlotPosition = (slot: ShiftSlot) => {
    const startMin = timeToMinutes(slot.slot_start)
    let endMin = timeToMinutes(slot.slot_end)
    if (endMin <= startMin) endMin += 24 * 60
    const tlStart = timelineStart * 60
    const left = ((startMin - tlStart) / 60) * HOUR_WIDTH
    const width = ((endMin - startMin) / 60) * HOUR_WIDTH
    return { left: Math.max(0, left), width: Math.max(40, width) }
  }

  const layoutSlots = (dateSlots: ShiftSlot[]) => {
    const blocks: { slot: ShiftSlot; blockIndex: number; row: number }[] = []
    const allBlocks: { slot: ShiftSlot; blockIndex: number; startMin: number; endMin: number }[] = []

    dateSlots.forEach(slot => {
      for (let i = 0; i < slot.required_workers; i++) {
        const startMin = timeToMinutes(slot.slot_start)
        let endMin = timeToMinutes(slot.slot_end)
        if (endMin <= startMin) endMin += 24 * 60
        allBlocks.push({ slot, blockIndex: i, startMin, endMin })
      }
    })

    const rows: { endMin: number }[] = []
    allBlocks.forEach(block => {
      let placed = false
      for (let r = 0; r < rows.length; r++) {
        if (block.startMin >= rows[r].endMin) {
          rows[r].endMin = block.endMin
          blocks.push({ slot: block.slot, blockIndex: block.blockIndex, row: r })
          placed = true
          break
        }
      }
      if (!placed) {
        rows.push({ endMin: block.endMin })
        blocks.push({ slot: block.slot, blockIndex: block.blockIndex, row: rows.length - 1 })
      }
    })

    return { blocks, totalRows: rows.length }
  }

  const ensureShiftExists = async (date: string): Promise<string> => {
    const existing = getShiftForDate(date)
    if (existing) return existing.id
    const { data } = await supabase.from('shifts').insert({ shift_date: date, created_by: currentUser.id }).select().single()
    return data!.id
  }

  const handleAddSlot = async (date: string) => {
    if (!editingSlot || !editingSlot.start || !editingSlot.end) return
    setSaving(true)
    const shiftId = await ensureShiftExists(date)
    const count = parseInt(editingSlot.count) || 1

    if (editingSlot.slotId) {
      await supabase.from('shift_slots').update({
        slot_start: editingSlot.start, slot_end: editingSlot.end, required_workers: count
      }).eq('id', editingSlot.slotId)
    } else {
      await supabase.from('shift_slots').insert({
        shift_id: shiftId, slot_start: editingSlot.start, slot_end: editingSlot.end, required_workers: count
      })
    }

    setEditingSlot(null)
    await loadWeekData()
    setSaving(false)
  }

  const handleDeleteSlot = async (slotId: string) => {
    if (!confirm('Smazat tento časový blok?')) return
    await supabase.from('shift_slots').update({ deleted_at: new Date().toISOString() }).eq('id', slotId)
    await loadWeekData()
  }

  const handleAssignWorker = async (slotId: string, userId: string) => {
    if (signups.find(s => s.slot_id === slotId && s.user_id === userId)) return
    await supabase.from('shift_signups').insert({ slot_id: slotId, user_id: userId, status: 'confirmed' })
    setAssigningSlot(null)
    await loadWeekData()
  }

  const handleRemoveSignup = async (signupId: string) => {
    await supabase.from('shift_signups').delete().eq('id', signupId)
    await loadWeekData()
  }

  const handleSaveTips = async (date: string) => {
    const shift = getShiftForDate(date)
    if (!shift) return
    const tipVal = tips[date]
    if (!tipVal?.amount) return
    const amount = parseFloat(tipVal.amount)
    if (isNaN(amount)) return
    if (tipVal.id) { await supabase.from('daily_tips').update({ total_tips: amount }).eq('id', tipVal.id) }
    else { await supabase.from('daily_tips').insert({ shift_id: shift.id, total_tips: amount, entered_by: currentUser.id }) }
    await loadWeekData()
  }

  const changeWeek = (dir: number) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + dir * 7)
    setWeekStart(d.toISOString().split('T')[0])
  }

  const handleCopyWeek = async () => {
    if (!confirm('Zkopírovat strukturu směn do dalšího týdne?')) return
    setSaving(true)
    const next = new Date(weekStart); next.setDate(next.getDate() + 7)
    for (let i = 0; i < 7; i++) {
      const srcDate = weekDates[i]
      const dst = new Date(next); dst.setDate(dst.getDate() + i)
      const dstStr = dst.toISOString().split('T')[0]
      const srcShift = getShiftForDate(srcDate)
      if (!srcShift) continue
      const srcSlots = getSlotsForShift(srcShift.id)
      if (!srcSlots.length) continue
      const { data: ex } = await supabase.from('shifts').select('id').eq('shift_date', dstStr).is('deleted_at', null).single()
      if (ex) continue
      const { data: ns } = await supabase.from('shifts').insert({ shift_date: dstStr, created_by: currentUser.id }).select().single()
      if (ns) {
        for (const s of srcSlots) {
          await supabase.from('shift_slots').insert({ shift_id: ns.id, slot_start: s.slot_start, slot_end: s.slot_end, required_workers: s.required_workers })
        }
      }
    }
    setSaving(false)
    await loadWeekData()
  }

  const handleClearWeekSignups = async () => {
    if (!confirm('Opravdu vymazat všechny přiřazené lidi v tomto týdnu? Bloky směn zůstanou.')) return
    setSaving(true)
    const weekSignups = signups.filter(s => {
      const slot = slots.find(sl => sl.id === s.slot_id)
      if (!slot) return false
      const shift = shifts.find(sh => sh.id === slot.shift_id)
      if (!shift) return false
      return weekDates.includes(shift.shift_date)
    })
    for (const signup of weekSignups) {
        await supabase.from('shift_signups').delete().eq('id', signup.id)
    }
    setSaving(false)
    await loadWeekData()
  }

  const fmt = (t: string) => t.slice(0, 5)
  const fmtDate = (d: string) => { const x = new Date(d); return `${x.getDate()}.${x.getMonth() + 1}.` }
  const weekLabel = () => {
    const s = new Date(weekStart); const e = new Date(weekStart); e.setDate(e.getDate() + 6)
    return `${s.getDate()}.${s.getMonth() + 1}. – ${e.getDate()}.${e.getMonth() + 1}. ${e.getFullYear()}`
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Načítám...</p></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-full mx-auto flex justify-between items-center px-2">
          <div className="flex items-center gap-4">
            <a href="/" className="text-lg font-bold text-gray-900">Saluti</a>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">Plánování směn</span>
          </div>
          <span className="text-sm text-gray-500">{currentUser?.email}</span>
        </div>
      </nav>

      <main className="max-w-full mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <button onClick={() => changeWeek(-1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&larr;</button>
            <span className="text-base font-semibold text-gray-900">{weekLabel()}</span>
            <button onClick={() => changeWeek(1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&rarr;</button>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <button onClick={() => setTimelineStart(Math.max(0, timelineStart - 2))} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs hover:bg-gray-50">&larr;</button>
              <span className="text-xs text-gray-500">{timelineStart}:00 – {(timelineStart + HOURS_VISIBLE) % 24}:00</span>
              <button onClick={() => setTimelineStart(Math.min(20, timelineStart + 2))} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs hover:bg-gray-50">&rarr;</button>
            </div>
            <button onClick={handleCopyWeek} disabled={saving} className="text-sm px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50">
              Kopírovat týden &rarr;
            </button>
            <button onClick={handleClearWeekSignups} disabled={saving} className="text-sm px-4 py-2 bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50">
              Vymazat přiřazení
            </button>
          </div>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="flex border-b border-gray-200 bg-gray-50">
            <div className="flex-shrink-0 border-r border-gray-200 px-3 py-2" style={{ width: LABEL_WIDTH }}>
              <span className="text-xs font-medium text-gray-500">Den</span>
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="flex" style={{ width: HOURS_VISIBLE * HOUR_WIDTH }}>
                {timelineHours.map(h => (
                  <div key={h} className="text-center text-xs text-gray-500 py-2 border-r border-gray-100 font-medium" style={{ width: HOUR_WIDTH }}>{h}:00</div>
                ))}
              </div>
            </div>
            <div className="flex-shrink-0 border-l border-gray-200 px-3 py-2" style={{ width: ACTIONS_WIDTH }}>
              <span className="text-xs font-medium text-gray-500">Akce</span>
            </div>
          </div>

          {weekDates.map((date, dayIndex) => {
            const shift = getShiftForDate(date)
            const dateSlots = shift ? getSlotsForShift(shift.id) : []
            const { blocks, totalRows } = layoutSlots(dateSlots)
            const workersOnDate = getWorkersOnDate(date)
            const tipData = tips[date]
            const tipPerPerson = tipData && workersOnDate.length > 0 ? Math.round(parseFloat(tipData.amount || '0') / workersOnDate.length) : null
            const isToday = date === new Date().toISOString().split('T')[0]
            const rowHeight = Math.max(60, totalRows * (SLOT_HEIGHT + SLOT_GAP) + 8)

            return (
              <div key={date} className={`flex border-b border-gray-100 ${isToday ? 'bg-orange-50/30' : ''}`}>
                <div className="flex-shrink-0 border-r border-gray-200 px-3 py-3 flex flex-col justify-center" style={{ width: LABEL_WIDTH }}>
                  <div className={`text-sm font-semibold ${isToday ? 'text-orange-600' : 'text-gray-900'}`}>
                    {dayNames[dayIndex]} {fmtDate(date)}
                  </div>
                  {tipData && parseFloat(tipData.amount || '0') > 0 && (
                    <div className="text-xs text-gray-400 mt-1">{tipData.amount} Kč{tipPerPerson ? ` (${tipPerPerson}/os)` : ''}</div>
                  )}
                </div>

                <div className="flex-1 overflow-hidden relative" style={{ minHeight: rowHeight }}>
                  <div className="relative" style={{ width: HOURS_VISIBLE * HOUR_WIDTH, height: '100%' }}>
                    {timelineHours.map((h, i) => (
                      <div key={h} className="absolute top-0 bottom-0 border-r border-gray-50" style={{ left: i * HOUR_WIDTH }} />
                    ))}

                    {blocks.map((block) => {
                      const pos = getSlotPosition(block.slot)
                      const slotSignups = getSignupsForSlot(block.slot.id)
                      const signup = slotSignups[block.blockIndex]
                      const isEmpty = !signup
                      const top = 4 + block.row * (SLOT_HEIGHT + SLOT_GAP)
                      const blockKey = `${block.slot.id}-${block.blockIndex}`

                      return (
                        <div
                          key={blockKey}
                          className={`absolute rounded border text-xs flex items-center px-2 gap-1 ${
                            isEmpty
                              ? 'bg-red-50 border-red-200'
                                : signup && isWorkerOverlapping(signup.user_id, date)
                               ? 'bg-red-100 border-red-400'
                               : 'bg-green-50 border-green-200'
                          }`}
                          style={{ left: pos.left, width: pos.width, top, height: SLOT_HEIGHT }}
                        >
                          <span className="text-gray-400 font-medium flex-shrink-0">
                            {fmt(block.slot.slot_start)}-{fmt(block.slot.slot_end)}
                          </span>
                          <div className="flex-1 min-w-0 flex items-center">
                            {signup ? (
                              <div className="flex items-center gap-1 flex-1 min-w-0">
                                <span className="text-gray-800 truncate font-medium">{signup.user_name}</span>
                                <button onClick={() => handleRemoveSignup(signup.id)} className="text-gray-400 hover:text-red-500 flex-shrink-0">✕</button>
                              </div>
                            ) : (
                              assigningSlot === blockKey ? (
                                <select
                                  onChange={(e) => { if (e.target.value) handleAssignWorker(block.slot.id, e.target.value) }}
                                  className="text-xs px-1 py-0 border border-gray-300 rounded w-full"
                                  defaultValue=""
                                  autoFocus
                                >
                                  <option value="">Vyber...</option>
                                  {workers
                                    .filter(w => !slotSignups.find(s => s.user_id === w.id))
                                    .map(w => (
                                      <option key={w.id} value={w.id}>{w.name}</option>
                                    ))
                                  }
                                </select>
                              ) : (
                                <button onClick={() => setAssigningSlot(blockKey)} className="text-blue-500 hover:text-blue-700 truncate">
                                  + přiřadit
                                </button>
                              )
                            )}
                          </div>
                        </div>
                      )
                    })}

                    {dateSlots.length === 0 && (
                      <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-300">Žádné směny</div>
                    )}
                  </div>
                </div>

                <div className="flex-shrink-0 border-l border-gray-200 px-3 py-3 flex flex-col gap-1 justify-start" style={{ width: ACTIONS_WIDTH }}>
                  <button
                    onClick={() => setEditingSlot({ date, start: '14:00', end: '22:00', count: '1', countMode: '1' })}
                    className="text-xs text-orange-600 hover:text-orange-700 text-left font-medium"
                  >
                    + Přidat blok
                  </button>
                  <div className="flex items-center gap-1 mt-1">
                    <input type="number" value={tipData?.amount || ''}
                      onChange={(e) => setTips(prev => ({ ...prev, [date]: { ...prev[date], amount: e.target.value } }))}
                      onBlur={() => handleSaveTips(date)} placeholder="Dýška"
                      className="w-16 text-xs px-1 py-1 border border-gray-200 rounded text-right"
                    />
                    <span className="text-xs text-gray-400">Kč</span>
                  </div>
                  {dateSlots.map(slot => (
                    <div key={slot.id} className="flex gap-2 text-xs items-center mt-1">
                      <span className="text-gray-400">{fmt(slot.slot_start)} ({slot.required_workers})</span>
                      <button onClick={() => setEditingSlot({
                        date, slotId: slot.id, start: slot.slot_start.slice(0, 5), end: slot.slot_end.slice(0, 5),
                        count: String(slot.required_workers), countMode: slot.required_workers <= 3 ? String(slot.required_workers) : 'more'
                      })} className="text-gray-400 hover:text-orange-500">✏️</button>
                      <button onClick={() => handleDeleteSlot(slot.id)} className="text-gray-400 hover:text-red-500">🗑</button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </main>

      {editingSlot && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 px-4">
          <div className="bg-white rounded-lg p-6 w-full max-w-sm">
            <h3 className="font-semibold text-gray-900 mb-4">
              {editingSlot.slotId ? 'Upravit blok' : 'Nový blok'} — {dayNames[weekDates.indexOf(editingSlot.date)]} {fmtDate(editingSlot.date)}
            </h3>
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm text-gray-600 mb-1">Od</label>
                  <select value={editingSlot.start} onChange={(e) => setEditingSlot(prev => prev ? { ...prev, start: e.target.value } : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="flex-1">
                  <label className="block text-sm text-gray-600 mb-1">Do</label>
                  <select value={editingSlot.end} onChange={(e) => setEditingSlot(prev => prev ? { ...prev, end: e.target.value } : null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                    {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-600 mb-2">Počet lidí</label>
                <div className="flex gap-0 border border-gray-300 rounded-lg overflow-hidden">
                  {['1', '2', '3', 'more'].map(opt => (
                    <button key={opt}
                      onClick={() => {
                        if (opt === 'more') setEditingSlot(prev => prev ? { ...prev, countMode: 'more', count: parseInt(prev.count) <= 3 ? '4' : prev.count } : null)
                        else setEditingSlot(prev => prev ? { ...prev, countMode: opt, count: opt } : null)
                      }}
                      className={`flex-1 py-2 text-sm font-medium transition-colors ${
                        editingSlot.countMode === opt ? 'bg-orange-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
                      } ${opt !== '1' ? 'border-l border-gray-300' : ''}`}
                    >{opt === 'more' ? 'Víc' : opt}</button>
                  ))}
                </div>
                {editingSlot.countMode === 'more' && (
                  <input type="number" min="4" value={editingSlot.count}
                    onChange={(e) => setEditingSlot(prev => prev ? { ...prev, count: e.target.value } : null)}
                    className="w-full mt-2 px-3 py-2 border border-gray-300 rounded-lg text-sm" placeholder="Zadej počet" autoFocus
                  />
                )}
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => handleAddSlot(editingSlot.date)} disabled={saving}
                className="flex-1 py-2 bg-orange-600 text-white text-sm rounded-lg hover:bg-orange-700 disabled:opacity-50">
                {saving ? 'Ukládám...' : 'Uložit'}
              </button>
              <button onClick={() => setEditingSlot(null)}
                className="flex-1 py-2 bg-white border border-gray-300 text-sm rounded-lg hover:bg-gray-50">Zrušit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}