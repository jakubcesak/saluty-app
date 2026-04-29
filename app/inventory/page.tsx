'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

type InventoryItem = {
  id: string
  name: string
  unit: string
  sort_order: number
  is_hidden: boolean
}

type InventoryRecord = {
  id: string
  item_id: string
  record_date: string
  quantity: number
  note: string | null
}

type UserRole = {
  role: string
  canEdit: boolean
  canDelete: boolean
}

export default function InventoryPage() {
  const [user, setUser] = useState<any>(null)
  const [userRole, setUserRole] = useState<UserRole>({ role: 'worker', canEdit: false, canDelete: false })
  const [items, setItems] = useState<InventoryItem[]>([])
  const [records, setRecords] = useState<InventoryRecord[]>([])
  const [compareRecords, setCompareRecords] = useState<InventoryRecord[]>([])
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0])
  const [compareDate, setCompareDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().split('T')[0]
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [showBulkAdd, setShowBulkAdd] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkUnit, setBulkUnit] = useState('ks')
  const [newItemName, setNewItemName] = useState('')
  const [newItemUnit, setNewItemUnit] = useState('ks')
  const [editValues, setEditValues] = useState<Record<string, { quantity: string; note: string }>>({})
  const [editingUnit, setEditingUnit] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { window.location.href = '/login'; return }
      setUser(user)

      const { data: dbUser } = await supabase
        .from('users')
        .select('role')
        .eq('id', user.id)
        .single()

      const { data: perms } = await supabase
        .from('user_permissions')
        .select('*')
        .eq('user_id', user.id)
        .eq('module', 'inventory')
        .single()

      setUserRole({
        role: dbUser?.role || 'worker',
        canEdit: perms?.can_edit || dbUser?.role === 'superadmin',
        canDelete: dbUser?.role === 'superadmin' || dbUser?.role === 'manager',
      })

      loadItems()
    })
  }, [])

  useEffect(() => {
    if (items.length > 0) {
      loadRecords()
      loadCompareRecords()
    }
  }, [selectedDate, compareDate, items])

  const loadItems = async () => {
    const { data } = await supabase
      .from('inventory_items')
      .select('*')
      .is('deleted_at', null)
      .order('sort_order')
    if (data) {
      const withHidden = data.map(i => ({ ...i, is_hidden: (i as any).is_hidden ?? false }))
      setItems(withHidden)
    }
    setLoading(false)
  }

  const loadRecords = async () => {
    const { data } = await supabase
      .from('inventory_records')
      .select('*')
      .eq('record_date', selectedDate)
      .is('deleted_at', null)

    if (data) {
      setRecords(data)
      const vals: Record<string, { quantity: string; note: string }> = {}
      items.forEach(item => {
        const rec = data.find(r => r.item_id === item.id)
        vals[item.id] = {
          quantity: rec ? String(rec.quantity) : '',
          note: rec?.note || ''
        }
      })
      setEditValues(vals)
    }
  }

  const loadCompareRecords = async () => {
    const { data } = await supabase
      .from('inventory_records')
      .select('*')
      .eq('record_date', compareDate)
      .is('deleted_at', null)
    if (data) setCompareRecords(data)
  }

  const handleSave = async () => {
    if (!user) return
    setSaving(true)

    for (const item of items) {
      const val = editValues[item.id]
      if (!val || val.quantity === '') continue
      const quantity = parseFloat(val.quantity)
      if (isNaN(quantity)) continue

      const existing = records.find(r => r.item_id === item.id)
      if (existing) {
        await supabase
          .from('inventory_records')
          .update({ quantity, note: val.note || null })
          .eq('id', existing.id)
      } else {
        await supabase
          .from('inventory_records')
          .insert({
            item_id: item.id,
            record_date: selectedDate,
            quantity,
            note: val.note || null,
            recorded_by: user.id
          })
      }
    }

    await loadRecords()
    await loadCompareRecords()
    setSaving(false)
  }

  const handleClearDay = async () => {
    if (!confirm('Opravdu smazat všechna množství a poznámky pro tento den?')) return
    setSaving(true)

    for (const rec of records) {
      await supabase
        .from('inventory_records')
        .delete()
        .eq('id', rec.id)
    }

    const vals: Record<string, { quantity: string; note: string }> = {}
    items.forEach(item => {
      vals[item.id] = { quantity: '', note: '' }
    })
    setEditValues(vals)
    setRecords([])
    setSaving(false)
  }

  const handleAddItem = async () => {
    if (!newItemName.trim()) return
    await supabase.from('inventory_items').insert({
      name: newItemName.trim(),
      unit: newItemUnit,
      sort_order: items.length,
      is_hidden: false
    })
    setNewItemName('')
    setNewItemUnit('ks')
    setShowAddForm(false)
    await loadItems()
  }

  const handleBulkAdd = async () => {
    if (!bulkText.trim()) return
    const lines = bulkText.split('\n').filter(l => l.trim())
    let added = 0

    for (const line of lines) {
      const parts = line.split('\t')
      const name = parts[0]?.trim()
      if (!name) continue

      const exists = items.find(i => i.name.toLowerCase() === name.toLowerCase())
      if (exists) continue

      const unit = parts[1]?.trim() || bulkUnit
      const quantityStr = parts[2]?.trim()
      const note = parts[3]?.trim() || null

      const { data: newItem } = await supabase.from('inventory_items').insert({
        name,
        unit: ['ks', 'kg', 'l', 'balení'].includes(unit) ? unit : bulkUnit,
        sort_order: items.length + added,
        is_hidden: false
      }).select().single()

      if (newItem && quantityStr) {
        const quantity = parseFloat(quantityStr.replace(',', '.'))
        if (!isNaN(quantity)) {
          await supabase.from('inventory_records').insert({
            item_id: newItem.id,
            record_date: selectedDate,
            quantity,
            note,
            recorded_by: user.id
          })
        }
      }

      added++
    }

    setBulkText('')
    setShowBulkAdd(false)
    await loadItems()
  }

  const handleUnitChange = async (itemId: string, newUnit: string) => {
    await supabase.from('inventory_items').update({ unit: newUnit }).eq('id', itemId)
    setEditingUnit(null)
    await loadItems()
  }

  const handleHideItem = async (itemId: string) => {
    await supabase.from('inventory_items').update({ is_hidden: true }).eq('id', itemId)
    await loadItems()
  }

  const handleUnhideItem = async (itemId: string) => {
    await supabase.from('inventory_items').update({ is_hidden: false }).eq('id', itemId)
    await loadItems()
  }

  const handleDeleteItem = async (itemId: string) => {
    if (!confirm('Opravdu trvale smazat tuto položku? Tato akce je nevratná.')) return
    await supabase.from('inventory_items').update({ deleted_at: new Date().toISOString() }).eq('id', itemId)
    await loadItems()
  }

  const adjustQuantity = (itemId: string, delta: number) => {
    setEditValues(prev => {
      const current = parseFloat(prev[itemId]?.quantity || '0') || 0
      const newVal = Math.max(0, current + delta)
      return {
        ...prev,
        [itemId]: { ...prev[itemId], quantity: String(newVal) }
      }
    })
  }

  const getChange = (itemId: string) => {
    const current = editValues[itemId]?.quantity
    const prev = compareRecords.find(r => r.item_id === itemId)
    if (!current || current === '' || !prev) return null
    return parseFloat(current) - prev.quantity
  }

  const changeDate = (days: number) => {
    const d = new Date(selectedDate)
    d.setDate(d.getDate() + days)
    setSelectedDate(d.toISOString().split('T')[0])
  }

  const handleExport = () => {
    const visibleItems = items.filter(i => !i.is_hidden)
    let csv = 'Položka\tJednotka\tMnožství\tZměna\tPoznámka\n'

    visibleItems.forEach(item => {
      const val = editValues[item.id]
      const change = getChange(item.id)
      csv += `${item.name}\t${item.unit}\t${val?.quantity || ''}\t${change !== null ? change : ''}\t${val?.note || ''}\n`
    })

    const blob = new Blob(['\ufeff' + csv], { type: 'text/tab-separated-values;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `zasoby_${selectedDate}.tsv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const visibleItems = items.filter(i => showHidden ? true : !i.is_hidden)
  const hiddenCount = items.filter(i => i.is_hidden).length

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Načítám...</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-4">
            <a href="/" className="text-lg font-bold text-gray-900">Saluti</a>
            <span className="text-gray-300">/</span>
            <span className="text-sm text-gray-600">Zásoby</span>
          </div>
          <span className="text-sm text-gray-500">{user?.email}</span>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Date controls */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 mb-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">Datum:</span>
            <button onClick={() => changeDate(-1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">←</button>
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="px-3 py-1 border border-gray-300 rounded-lg text-sm"
            />
            <button onClick={() => changeDate(1)} className="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">→</button>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-600">Porovnat s:</span>
            <input
              type="date"
              value={compareDate}
              onChange={(e) => setCompareDate(e.target.value)}
              className="px-3 py-1 border border-gray-300 rounded-lg text-sm"
            />
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2 mb-6">
          <button
            onClick={() => { setShowAddForm(!showAddForm); setShowBulkAdd(false) }}
            className="text-sm px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            + Položka
          </button>
          <button
            onClick={() => { setShowBulkAdd(!showBulkAdd); setShowAddForm(false) }}
            className="text-sm px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            📋 Vložit z Excelu
          </button>
          <button
            onClick={handleExport}
            className="text-sm px-4 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            📥 Export
          </button>
          <button
            onClick={handleClearDay}
            className="text-sm px-4 py-2 bg-white border border-red-200 text-red-600 rounded-lg hover:bg-red-50"
          >
            🗑 Smazat den
          </button>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowHidden(!showHidden)}
              className={`text-sm px-4 py-2 rounded-lg border ${showHidden ? 'bg-orange-50 border-orange-300 text-orange-700' : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'}`}
            >
              {showHidden ? `Skrýt skryté (${hiddenCount})` : `Zobrazit skryté (${hiddenCount})`}
            </button>
          )}
        </div>

        {/* Single item add */}
        {showAddForm && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6 flex flex-col sm:flex-row gap-3">
            <input
              type="text"
              placeholder="Název položky"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <select
              value={newItemUnit}
              onChange={(e) => setNewItemUnit(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <option value="ks">ks</option>
              <option value="kg">kg</option>
              <option value="l">l</option>
              <option value="balení">balení</option>
            </select>
            <button
              onClick={handleAddItem}
              className="px-4 py-2 bg-orange-600 text-white text-sm rounded-lg hover:bg-orange-700"
            >
              Přidat
            </button>
          </div>
        )}

        {/* Bulk add from Excel */}
        {showBulkAdd && (
          <div className="bg-white border border-gray-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-gray-600 mb-1">
              Zkopírujte z Excelu a vložte sem. Podporované sloupce (oddělené tabulátorem):
            </p>
            <p className="text-xs text-gray-400 mb-3">
              Název | Jednotka (ks/kg/l/balení) | Množství | Poznámka — stačí jen název, ostatní jsou volitelné
            </p>
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={"Pilsner Urquell 0.5l\tks\t48\tObjednat\nKozel 11° sud 50l\tks\t3\nCitróny\tkg\t2.5"}
              rows={8}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono mb-3"
            />
            <div className="flex items-center gap-3">
              <span className="text-sm text-gray-600">Výchozí jednotka (když chybí):</span>
              <select
                value={bulkUnit}
                onChange={(e) => setBulkUnit(e.target.value)}
                className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="ks">ks</option>
                <option value="kg">kg</option>
                <option value="l">l</option>
                <option value="balení">balení</option>
              </select>
              <button
                onClick={handleBulkAdd}
                className="px-4 py-2 bg-orange-600 text-white text-sm rounded-lg hover:bg-orange-700"
              >
                Vložit položky
              </button>
              <span className="text-xs text-gray-400">
                {bulkText.split('\n').filter(l => l.trim()).length} řádků
              </span>
            </div>
          </div>
        )}

        {/* Inventory table */}
        {items.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-12 text-center">
            <p className="text-gray-500">Zatím nemáte žádné položky.</p>
            <button onClick={() => setShowBulkAdd(true)} className="mt-4 text-sm text-orange-600 hover:text-orange-700">
              Nahrajte je z Excelu
            </button>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Položka</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500 w-20">Jedn.</th>
                    <th className="text-center px-4 py-3 font-medium text-gray-500 w-40">Množství</th>
                    <th className="text-right px-4 py-3 font-medium text-gray-500 w-24">Změna</th>
                    <th className="text-left px-4 py-3 font-medium text-gray-500">Poznámka</th>
                    <th className="w-16"></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => {
                    const change = getChange(item.id)
                    return (
                      <tr key={item.id} className={`border-b border-gray-100 ${item.is_hidden ? 'bg-gray-50 opacity-60' : ''}`}>
                        <td className="px-4 py-3 font-medium text-gray-900">
                          {item.name}
                          {item.is_hidden && <span className="ml-2 text-xs text-gray-400">(skryté)</span>}
                        </td>
                        <td className="px-4 py-3">
                          {editingUnit === item.id ? (
                            <select
                              value={item.unit}
                              onChange={(e) => handleUnitChange(item.id, e.target.value)}
                              onBlur={() => setEditingUnit(null)}
                              autoFocus
                              className="w-16 px-1 py-1 border border-gray-300 rounded text-sm"
                            >
                              <option value="ks">ks</option>
                              <option value="kg">kg</option>
                              <option value="l">l</option>
                              <option value="balení">balení</option>
                            </select>
                          ) : (
                            <span
                              onClick={() => setEditingUnit(item.id)}
                              className="text-gray-500 cursor-pointer hover:text-orange-600"
                              title="Klikni pro změnu"
                            >
                              {item.unit}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => adjustQuantity(item.id, -1)}
                              className="w-8 h-8 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded text-lg font-medium text-gray-600"
                            >
                              −
                            </button>
                            <input
                              type="number"
                              step="0.1"
                              value={editValues[item.id]?.quantity || ''}
                              onChange={(e) => setEditValues(prev => ({
                                ...prev,
                                [item.id]: { ...prev[item.id], quantity: e.target.value }
                              }))}
                              className="w-16 px-2 py-1 border border-gray-300 rounded text-center text-sm"
                              placeholder="0"
                            />
                            <button
                              onClick={() => adjustQuantity(item.id, 1)}
                              className="w-8 h-8 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded text-lg font-medium text-gray-600"
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {change !== null ? (
                            <span className={
                              change > 0 ? 'text-green-600 font-medium' :
                              change < 0 ? 'text-red-600 font-medium' :
                              'text-gray-400'
                            }>
                              {change > 0 ? '+' : ''}{change}
                            </span>
                          ) : (
                            <span className="text-gray-300">–</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <input
                            type="text"
                            value={editValues[item.id]?.note || ''}
                            onChange={(e) => setEditValues(prev => ({
                              ...prev,
                              [item.id]: { ...prev[item.id], note: e.target.value }
                            }))}
                            className="w-full px-2 py-1 border border-gray-300 rounded text-sm"
                            placeholder="Poznámka..."
                          />
                        </td>
                        <td className="px-4 py-3 text-center">
                          {item.is_hidden ? (
                            <div className="flex gap-1">
                              <button
                                onClick={() => handleUnhideItem(item.id)}
                                className="text-gray-400 hover:text-green-500 text-xs"
                                title="Zobrazit"
                              >
                                👁
                              </button>
                              {userRole.canDelete && (
                                <button
                                  onClick={() => handleDeleteItem(item.id)}
                                  className="text-gray-400 hover:text-red-500 text-xs"
                                  title="Trvale smazat"
                                >
                                  🗑
                                </button>
                              )}
                            </div>
                          ) : (
                            <button
                              onClick={() => handleHideItem(item.id)}
                              className="text-gray-400 hover:text-orange-500 text-sm"
                              title="Skrýt"
                            >
                              ✕
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3 bg-gray-50 border-t border-gray-200 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <span className="text-xs text-gray-400">
                {visibleItems.length} položek · Změna oproti {new Date(compareDate).toLocaleDateString('cs-CZ')}
              </span>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-6 py-2 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                {saving ? 'Ukládám...' : 'Uložit inventuru'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}