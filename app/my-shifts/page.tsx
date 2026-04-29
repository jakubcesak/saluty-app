'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

type Shift = { id: string; shift_date: string }
type ShiftSlot = { id: string; shift_id: string; slot_start: string; slot_end: string; required_workers: number }
type ShiftSignup = { id: string; slot_id: string; user_id: string; status: string; user_name?: string }
type DailyTip = { id: string; shift_id: string; total_tips: number }

const SLOT_HEIGHT = 28
const SLOT_GAP = 2
const HOUR_WIDTH = 80
const LABEL_WIDTH = 120
const STATS_WIDTH = 160
const HOURS_VISIBLE = 14

export default function MyShiftsPage() {
  const [user, setUser] = useState<any>(null)
  const [dbUser, setDbUser] = useState<any>(null)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [slots, setSlots] = useState<ShiftSlot[]>([])
  const [signups, setSignups] = useState<ShiftSignup[]>([])
  const [tips, setTips] = useState<DailyTip[]>([])
  const [allUsers, setAllUsers] = useState<{ id: string; name: string }[]>([])
  const [weekStart, setWeekStart] = useState(() => {
    const d = new Date()
    const day = d.getDay()
    const diff = d.getDate() - day + (day === 0 ? -6 : 1)
    const monday = new Date(d.setDate(diff))
    return monday.toISOString().split('T')[0]
  })
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
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
      setUser(user)
      const { data: du } = await supabase.from('users').select('*').eq('id', user.id).single()
      setDbUser(du)
      const { data: users } = await supabase.from('users').select('id, name').is('deleted_at', null)
      if (users) setAllUsers(users)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!loading && user) loadWeekData()
  }, [weekStart, loading])

  const loadWeekData = async () => {
    const endDate = weekDates[6]
    const { data: shiftsData } = await supabase.from('shifts').select('*')
      .gte('shift_date', weekStart).lte('shift_date', endDate)
      .is('deleted_at', null).order('shift_date')

    if (!shiftsData) return
    setShifts(shiftsData)
    const shiftIds = shiftsData.map(s => s.id)
    if (shiftIds.length === 0) { setSlots([]); setSignups([]); setTips([]); return }

    const { data: slotsData } = await supabase.from('shift_slots').select('*')
      .in('shift_id', shiftIds).is('deleted_at', null).order('slot_start')
    if (slotsData) setSlots(slotsData); else { setSlots([]); setSignups([]); return }

    const slotIds = (slotsData || []).map(s => s.id)
    if (slotIds.length > 0) {
      const { data: signupsData } = await supabase.from('shift_signups').select('*')
        .in('slot_id', slotIds).eq('status', 'confirmed')
      if (signupsData) {
        setSignups(signupsData.map(s => ({
          ...s, user_name: allUsers.find(u => u.id === s.user_id)?.name || '?'
        })))
      }
    } else { setSignups([]) }

    const { data: tipsData } = await supabase.from('daily_tips').select('*').in('shift_id', shiftIds)
    if (tipsData) setTips(tipsData); else setTips([])
  }

  const getShiftForDate = (date: string) => shifts.find(s => s.shift_date === date)
  const getSlotsForDate = (date: string) => {
    const shift = getShiftForDate(date)
    if (!shift) return []
    return slots.filter(s => s.shift_id === shift.id).sort((a, b) => a.slot_start.localeCompare(b.slot_start))
  }
  const getSignupsForSlot = (slotId: string) => signups.filter(s => s.slot_id === slotId)
  const isSignedUp = (slotId: string) => signups.some(s => s.slot_id === slotId && s.user_id === user?.id)
  const getMySignup = (slotId: string) => signups.find(s => s.slot_id === slotId && s.user_id === user?.id)

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

  const handleSignUp = async (slotId: string) => {
    if (!user) return
    setActionLoading(slotId)
    await supabase.from('shift_signups').insert({ slot_id: slotId, user_id: user.id, status: 'confirmed' })
    await loadWeekData()
    setActionLoading(null)
  }

  const handleSignOff = async (slotId: string) => {
    if (!user) return
    const signup = getMySignup(slotId)
    if (!signup) return
    setActionLoading(slotId)
    await supabase.from('shift_signups').delete().eq('id', signup.id)
    await loadWeekData()
    setActionLoading(null)
  }

  const changeWeek = (dir: number) => {
    const d = new Date(weekStart); d.setDate(d.getDate() + dir * 7)
    setWeekStart(d.toISOString().split('T')[0])
  }

  const fmt = (t: string) => t.slice(0, 5)
  const fmtDate = (d: string) => { const x = new Date(d); return `${x.getDate()}.${x.getMonth() + 1}.` }
  const weekLabel = () => {
    const s = new Date(weekStart); const e = new Date(weekStart); e.setDate(e.getDate() + 6)
    return `${s.getDate()}.${s.getMonth() + 1}. – ${e.getDate()}.${e.getMonth() + 1}. ${e.getFullYear()}`
  }

  const getMyHoursThisWeek = () => {
    let total = 0
    weekDates.forEach(date => {
      getSlotsForDate(date).forEach(slot => {
        if (isSignedUp(slot.id)) {
          const start = slot.slot_start.split(':').map(Number)
          const end = slot.slot_end.split(':').map(Number)
          let hours = (end[0] + end[1] / 60) - (start[0] + start[1] / 60)
          if (hours < 0) hours += 24
          total += hours
        }
      })
    })
    return Math.round(total * 10) / 10
  }

  const getMyTipsThisWeek = () => {
    let total = 0
    weekDates.forEach(date => {
      const shift = getShiftForDate(date)
      if (!shift) return
      const tip = tips.find(t => t.shift_id === shift.id)
      if (!tip || tip.total_tips === 0) return
      const dateSlots = getSlotsForDate(date)
      const workerIds = new Set<string>()
      dateSlots.forEach(slot => getSignupsForSlot(slot.id).forEach(s => workerIds.add(s.user_id)))
      if (workerIds.has(user?.id)) total += Math.round(tip.total_tips / workerIds.size)
    })
    return total
  }

  const getMyShiftCount = () => {
    let count = 0
    weekDates.forEach(date => {
      if (getSlotsForDate(date).some(slot => isSignedUp(slot.id))) count++
    })
    return count
  }

  const getWorkersOnDate = (date: string) => {
    const dateSlots = getSlotsForDate(date)
    const ids = new Set<string>()
    dateSlots.forEach(slot => getSignupsForSlot(slot.id).forEach(s => ids.add(s.user_id)))
    return Array.from(ids)
  }

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Načítám...</p></div>

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-full mx-auto flex justify-between items-center px-2">
          <div className="flex items-center gap-4">
            <a href="/" className="text-lg font-bold text-gray-900">Saluti</a>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">Moje směny</span>
          </div>
          <span className="text-sm text-gray-500">{dbUser?.name || user?.email}</span>
        </div>
      </nav>

      <main className="max-w-full mx-auto px-4 py-6">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-4 max-w-md">
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs text-gray-500">Směn</div>
            <div className="text-lg font-semibold text-gray-900">{getMyShiftCount()}</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs text-gray-500">Hodin</div>
            <div className="text-lg font-semibold text-gray-900">{getMyHoursThisWeek()} h</div>
          </div>
          <div className="bg-white border border-gray-200 rounded-lg p-3">
            <div className="text-xs text-gray-500">Dýška</div>
            <div className="text-lg font-semibold text-gray-900">{getMyTipsThisWeek()} Kč</div>
          </div>
        </div>

        {/* Week navigation + timeline controls */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <button onClick={() => changeWeek(-1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&larr;</button>
            <span className="text-base font-semibold text-gray-900">{weekLabel()}</span>
            <button onClick={() => changeWeek(1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">&rarr;</button>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setTimelineStart(Math.max(0, timelineStart - 2))} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs hover:bg-gray-50">&larr;</button>
            <span className="text-xs text-gray-500">{timelineStart}:00 – {(timelineStart + HOURS_VISIBLE) % 24}:00</span>
            <button onClick={() => setTimelineStart(Math.min(20, timelineStart + 2))} className="px-2 py-1 bg-white border border-gray-300 rounded text-xs hover:bg-gray-50">&rarr;</button>
          </div>
        </div>

        {/* Legend */}
        <div className="flex gap-4 mb-3 text-xs text-gray-500">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-green-100 border border-green-300"></div>
            Přihlášen/a
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-blue-50 border border-blue-300"></div>
            Volné — klikni pro přihlášení
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded bg-gray-50 border border-gray-200"></div>
            Obsazeno
          </div>
        </div>

        {/* Timeline grid */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          {/* Header */}
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
            <div className="flex-shrink-0 border-l border-gray-200 px-3 py-2" style={{ width: STATS_WIDTH }}>
              <span className="text-xs font-medium text-gray-500">Info</span>
            </div>
          </div>

          {/* Day rows */}
          {weekDates.map((date, dayIndex) => {
            const dateSlots = getSlotsForDate(date)
            const { blocks, totalRows } = layoutSlots(dateSlots)
            const isToday = date === new Date().toISOString().split('T')[0]
            const rowHeight = Math.max(60, totalRows * (SLOT_HEIGHT + SLOT_GAP) + 8)
            const hasMyShift = dateSlots.some(slot => isSignedUp(slot.id))
            const workersOnDate = getWorkersOnDate(date)
            const shift = getShiftForDate(date)
            const tip = shift ? tips.find(t => t.shift_id === shift.id) : null
            const myTipShare = tip && workersOnDate.length > 0 && workersOnDate.includes(user?.id)
              ? Math.round(tip.total_tips / workersOnDate.length) : null

            return (
              <div key={date} className={`flex border-b border-gray-100 ${
                isToday ? 'bg-orange-50/30' : hasMyShift ? 'bg-green-50/20' : ''
              }`}>
                {/* Day label */}
                <div className="flex-shrink-0 border-r border-gray-200 px-3 py-3 flex flex-col justify-center" style={{ width: LABEL_WIDTH }}>
                  <div className={`text-sm font-semibold ${isToday ? 'text-orange-600' : 'text-gray-900'}`}>
                    {dayNames[dayIndex]} {fmtDate(date)}
                  </div>
                </div>

                {/* Timeline */}
                <div className="flex-1 overflow-hidden relative" style={{ minHeight: rowHeight }}>
                  <div className="relative" style={{ width: HOURS_VISIBLE * HOUR_WIDTH, height: '100%' }}>
                    {timelineHours.map((h, i) => (
                      <div key={h} className="absolute top-0 bottom-0 border-r border-gray-50" style={{ left: i * HOUR_WIDTH }} />
                    ))}

                    {blocks.map((block) => {
                      const pos = getSlotPosition(block.slot)
                      const slotSignups = getSignupsForSlot(block.slot.id)
                      const signup = slotSignups[block.blockIndex]
                      const isMe = signup?.user_id === user?.id
                      const isEmpty = !signup
                      const iAmAlreadyInSlot = isSignedUp(block.slot.id)
                      const top = 4 + block.row * (SLOT_HEIGHT + SLOT_GAP)
                      const blockKey = `${block.slot.id}-${block.blockIndex}`
                      const isLoading = actionLoading === block.slot.id

                      let bgClass = ''
                      let content = null

                      if (isMe) {
                        bgClass = 'bg-green-100 border-green-400 cursor-pointer hover:bg-green-200'
                        content = (
                          <div className="flex items-center justify-between w-full" onClick={() => !isLoading && handleSignOff(block.slot.id)}>
                            <span className="text-gray-400 font-medium flex-shrink-0">{fmt(block.slot.slot_start)}-{fmt(block.slot.slot_end)}</span>
                            <span className="text-green-800 font-medium truncate mx-1">Ty</span>
                            <span className="text-green-600 hover:text-red-500 flex-shrink-0 text-xs">{isLoading ? '...' : 'Odhlásit'}</span>
                          </div>
                        )
                      } else if (isEmpty && !iAmAlreadyInSlot) {
                        bgClass = 'bg-blue-50 border-blue-300 cursor-pointer hover:bg-blue-100'
                        content = (
                          <div className="flex items-center w-full" onClick={() => !isLoading && handleSignUp(block.slot.id)}>
                            <span className="text-gray-400 font-medium flex-shrink-0">{fmt(block.slot.slot_start)}-{fmt(block.slot.slot_end)}</span>
                            <span className="text-blue-600 font-medium ml-2 truncate">{isLoading ? 'Přihlašuji...' : '+ Přihlásit se'}</span>
                          </div>
                        )
                      } else if (isEmpty && iAmAlreadyInSlot) {
                        bgClass = 'bg-blue-50/50 border-blue-200'
                        content = (
                          <div className="flex items-center w-full">
                            <span className="text-gray-400 font-medium flex-shrink-0">{fmt(block.slot.slot_start)}-{fmt(block.slot.slot_end)}</span>
                            <span className="text-blue-400 ml-2 truncate">Volné místo</span>
                          </div>
                        )
                      } else {
                        bgClass = 'bg-gray-50 border-gray-200'
                        content = (
                          <div className="flex items-center w-full">
                            <span className="text-gray-400 font-medium flex-shrink-0">{fmt(block.slot.slot_start)}-{fmt(block.slot.slot_end)}</span>
                            <span className="text-gray-500 ml-2 truncate">{signup?.user_name}</span>
                          </div>
                        )
                      }

                      return (
                        <div
                          key={blockKey}
                          className={`absolute rounded border text-xs flex items-center px-2 gap-1 ${bgClass}`}
                          style={{ left: pos.left, width: pos.width, top, height: SLOT_HEIGHT }}
                        >
                          {content}
                        </div>
                      )
                    })}

                    {dateSlots.length === 0 && (
                      <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-300">Žádné směny</div>
                    )}
                  </div>
                </div>

                {/* Info panel */}
                <div className="flex-shrink-0 border-l border-gray-200 px-3 py-3 flex flex-col gap-1 justify-center" style={{ width: STATS_WIDTH }}>
                  {hasMyShift && (
                    <div className="text-xs text-green-600 font-medium">Na směně</div>
                  )}
                  {myTipShare && (
                    <div className="text-xs text-gray-500">Dýška: {myTipShare} Kč</div>
                  )}
                  {!hasMyShift && dateSlots.length > 0 && (
                    <div className="text-xs text-gray-400">Nepřihlášen/a</div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </main>
    </div>
  )
}