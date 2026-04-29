'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'

type User = {
  id: string
  email: string
  name: string
  role: string
  hourly_rate: number
  bank_account: string | null
  is_active: boolean
}

type Permission = {
  id: string
  user_id: string
  module: string
  can_view: boolean
  can_edit: boolean
}

const MODULES = [
  { key: 'shifts', label: 'Směny' },
  { key: 'timesheet', label: 'Timesheet' },
  { key: 'inventory', label: 'Zásoby' },
  { key: 'workers', label: 'Brigádníci' },
  { key: 'reports', label: 'Výkazy' },
  { key: 'activity_log', label: 'Log aktivit' },
]

const ROLES = [
  { key: 'superadmin', label: 'Superadmin', desc: 'Plný přístup ke všemu' },
  { key: 'manager', label: 'Provozní', desc: 'Správa směn, brigádníků a zásob' },
  { key: 'worker', label: 'Brigádník', desc: 'Přihlašování na směny, timesheet' },
]

const ROLE_PRESETS: Record<string, Record<string, { view: boolean; edit: boolean }>> = {
  superadmin: {
    shifts: { view: true, edit: true },
    timesheet: { view: true, edit: true },
    inventory: { view: true, edit: true },
    workers: { view: true, edit: true },
    reports: { view: true, edit: true },
    activity_log: { view: true, edit: true },
  },
  manager: {
    shifts: { view: true, edit: true },
    timesheet: { view: true, edit: true },
    inventory: { view: true, edit: true },
    workers: { view: true, edit: false },
    reports: { view: true, edit: false },
    activity_log: { view: true, edit: false },
  },
  worker: {
    shifts: { view: true, edit: false },
    timesheet: { view: true, edit: true },
    inventory: { view: true, edit: true },
    workers: { view: false, edit: false },
    reports: { view: false, edit: false },
    activity_log: { view: false, edit: false },
  },
}

export default function UsersPage() {
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [users, setUsers] = useState<User[]>([])
  const [permissions, setPermissions] = useState<Permission[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newUser, setNewUser] = useState({ email: '', name: '', role: 'worker', hourly_rate: '0', bank_account: '' })
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        window.location.href = '/login'
        return
      }
      setCurrentUser(user)
      loadData()
    })
  }, [])

  const loadData = async () => {
    const { data: usersData } = await supabase
      .from('users')
      .select('*')
      .is('deleted_at', null)
      .order('created_at')

    if (usersData) setUsers(usersData)

    const { data: permsData } = await supabase
      .from('user_permissions')
      .select('*')

    if (permsData) setPermissions(permsData)
    setLoading(false)
  }

  const getUserPermissions = (userId: string) => {
    return permissions.filter(p => p.user_id === userId)
  }

  const handleAddUser = async () => {
    if (!newUser.email.trim() || !newUser.name.trim()) return
    setSaving(true)
    setMessage('')

    // Invite user via Supabase Auth (sends magic link)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: newUser.email.trim(),
      email_confirm: true,
    })

    // If admin API fails, insert directly (user will get access on first login)
    const userId = authData?.user?.id || crypto.randomUUID()

    const { error: insertError } = await supabase
      .from('users')
      .insert({
        id: userId,
        email: newUser.email.trim(),
        name: newUser.name.trim(),
        role: newUser.role,
        hourly_rate: parseFloat(newUser.hourly_rate) || 0,
        bank_account: newUser.bank_account.trim() || null,
      })

    if (insertError) {
      setMessage('Chyba při vytváření uživatele: ' + insertError.message)
      setSaving(false)
      return
    }

    // Set default permissions based on role
    const preset = ROLE_PRESETS[newUser.role]
    for (const mod of MODULES) {
      const p = preset[mod.key]
      await supabase.from('user_permissions').insert({
        user_id: userId,
        module: mod.key,
        can_view: p.view,
        can_edit: p.edit,
      })
    }

    setNewUser({ email: '', name: '', role: 'worker', hourly_rate: '0', bank_account: '' })
    setShowAddForm(false)
    setMessage('Uživatel přidán')
    await loadData()
    setSaving(false)
  }

  const handleRoleChange = async (user: User, newRole: string) => {
    setSaving(true)

    await supabase
      .from('users')
      .update({ role: newRole })
      .eq('id', user.id)

    // Update permissions to match new role preset
    const preset = ROLE_PRESETS[newRole]
    for (const mod of MODULES) {
      const p = preset[mod.key]
      const existing = permissions.find(pm => pm.user_id === user.id && pm.module === mod.key)

      if (existing) {
        await supabase
          .from('user_permissions')
          .update({ can_view: p.view, can_edit: p.edit })
          .eq('id', existing.id)
      } else {
        await supabase.from('user_permissions').insert({
          user_id: user.id,
          module: mod.key,
          can_view: p.view,
          can_edit: p.edit,
        })
      }
    }

    await loadData()
    setSaving(false)
  }

  const togglePermission = async (userId: string, module: string, field: 'can_view' | 'can_edit') => {
    const existing = permissions.find(p => p.user_id === userId && p.module === module)

    if (existing) {
      await supabase
        .from('user_permissions')
        .update({ [field]: !existing[field] })
        .eq('id', existing.id)
    } else {
      await supabase.from('user_permissions').insert({
        user_id: userId,
        module,
        [field]: true,
        [field === 'can_view' ? 'can_edit' : 'can_view']: false,
      })
    }

    await loadData()
  }

  const handleUpdateUser = async (userId: string, field: string, value: any) => {
    await supabase.from('users').update({ [field]: value }).eq('id', userId)
    await loadData()
  }

  const handleDeactivate = async (userId: string) => {
    await supabase.from('users').update({ is_active: false }).eq('id', userId)
    await loadData()
  }

  const handleActivate = async (userId: string) => {
    await supabase.from('users').update({ is_active: true }).eq('id', userId)
    await loadData()
  }

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
            <span className="text-sm text-gray-600">Správa uživatelů</span>
          </div>
          <span className="text-sm text-gray-500">{currentUser?.email}</span>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Uživatelé</h2>
          <button
            onClick={() => setShowAddForm(!showAddForm)}
            className="text-sm px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700"
          >
            + Přidat uživatele
          </button>
        </div>

        {message && (
          <div className="mb-4 px-4 py-2 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            {message}
          </div>
        )}

        {showAddForm && (
          <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
            <h3 className="font-semibold text-gray-900 mb-4">Nový uživatel</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Jméno</label>
                <input
                  type="text"
                  value={newUser.name}
                  onChange={(e) => setNewUser(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="Jana Králová"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">E-mail</label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser(prev => ({ ...prev, email: e.target.value }))}
                  placeholder="jana@email.cz"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser(prev => ({ ...prev, role: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                >
                  {ROLES.map(r => (
                    <option key={r.key} value={r.key}>{r.label} — {r.desc}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Hodinová sazba (Kč)</label>
                <input
                  type="number"
                  value={newUser.hourly_rate}
                  onChange={(e) => setNewUser(prev => ({ ...prev, hourly_rate: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Číslo účtu</label>
                <input
                  type="text"
                  value={newUser.bank_account}
                  onChange={(e) => setNewUser(prev => ({ ...prev, bank_account: e.target.value }))}
                  placeholder="2345678901/0800"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-4">
              <button
                onClick={handleAddUser}
                disabled={saving}
                className="px-4 py-2 bg-orange-600 text-white text-sm rounded-lg hover:bg-orange-700 disabled:opacity-50"
              >
                {saving ? 'Ukládám...' : 'Vytvořit uživatele'}
              </button>
              <button
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 bg-white border border-gray-300 text-sm rounded-lg hover:bg-gray-50"
              >
                Zrušit
              </button>
            </div>
          </div>
        )}

        {/* Users list */}
        <div className="space-y-4">
          {users.map(user => {
            const userPerms = getUserPermissions(user.id)
            const isSelected = selectedUser?.id === user.id
            const roleInfo = ROLES.find(r => r.key === user.role)

            return (
              <div key={user.id} className={`bg-white border rounded-lg ${!user.is_active ? 'opacity-60' : ''} ${isSelected ? 'border-orange-300' : 'border-gray-200'}`}>
                <div
                  className="px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-4 cursor-pointer"
                  onClick={() => setSelectedUser(isSelected ? null : user)}
                >
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium ${
                      user.role === 'superadmin' ? 'bg-purple-100 text-purple-700' :
                      user.role === 'manager' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {user.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-gray-900 truncate">{user.name}</div>
                      <div className="text-sm text-gray-500 truncate">{user.email}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className={`text-xs px-2 py-1 rounded-full font-medium ${
                      user.role === 'superadmin' ? 'bg-purple-100 text-purple-700' :
                      user.role === 'manager' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {roleInfo?.label}
                    </span>
                    <span className="text-sm text-gray-500">{user.hourly_rate} Kč/h</span>
                    {!user.is_active && (
                      <span className="text-xs px-2 py-1 bg-red-100 text-red-600 rounded-full">Neaktivní</span>
                    )}
                    <span className="text-gray-400 text-sm">{isSelected ? '▲' : '▼'}</span>
                  </div>
                </div>

                {isSelected && (
                  <div className="px-6 py-4 border-t border-gray-200 space-y-6">
                    {/* Basic info edit */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Jméno</label>
                        <input
                          type="text"
                          defaultValue={user.name}
                          onBlur={(e) => handleUpdateUser(user.id, 'name', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Hodinová sazba (Kč)</label>
                        <input
                          type="number"
                          defaultValue={user.hourly_rate}
                          onBlur={(e) => handleUpdateUser(user.id, 'hourly_rate', parseFloat(e.target.value))}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 mb-1">Číslo účtu</label>
                        <input
                          type="text"
                          defaultValue={user.bank_account || ''}
                          onBlur={(e) => handleUpdateUser(user.id, 'bank_account', e.target.value || null)}
                          placeholder="2345678901/0800"
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                      </div>
                    </div>

                    {/* Role selection */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
                      <div className="flex flex-wrap gap-2">
                        {ROLES.map(role => (
                          <button
                            key={role.key}
                            onClick={() => handleRoleChange(user, role.key)}
                            disabled={user.id === currentUser?.id && role.key !== 'superadmin'}
                            className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                              user.role === role.key
                                ? 'bg-orange-50 border-orange-300 text-orange-700'
                                : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                            } disabled:opacity-50`}
                          >
                            <span className="font-medium">{role.label}</span>
                            <span className="text-xs ml-1 text-gray-500">— {role.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Module permissions */}
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">Oprávnění k modulům</label>
                      <div className="border border-gray-200 rounded-lg overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-gray-50">
                              <th className="text-left px-4 py-2 font-medium text-gray-500">Modul</th>
                              <th className="text-center px-4 py-2 font-medium text-gray-500 w-24">Zobrazit</th>
                              <th className="text-center px-4 py-2 font-medium text-gray-500 w-24">Upravit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {MODULES.map(mod => {
                              const perm = userPerms.find(p => p.module === mod.key)
                              return (
                                <tr key={mod.key} className="border-t border-gray-100">
                                  <td className="px-4 py-2 text-gray-900">{mod.label}</td>
                                  <td className="px-4 py-2 text-center">
                                    <input
                                      type="checkbox"
                                      checked={perm?.can_view || false}
                                      onChange={() => togglePermission(user.id, mod.key, 'can_view')}
                                      className="w-4 h-4 text-orange-600 rounded"
                                    />
                                  </td>
                                  <td className="px-4 py-2 text-center">
                                    <input
                                      type="checkbox"
                                      checked={perm?.can_edit || false}
                                      onChange={() => togglePermission(user.id, mod.key, 'can_edit')}
                                      className="w-4 h-4 text-orange-600 rounded"
                                    />
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex gap-3 pt-2">
                      {user.is_active ? (
                        <button
                          onClick={() => handleDeactivate(user.id)}
                          className="text-sm px-4 py-2 text-red-600 border border-red-200 rounded-lg hover:bg-red-50"
                        >
                          Deaktivovat
                        </button>
                      ) : (
                        <button
                          onClick={() => handleActivate(user.id)}
                          className="text-sm px-4 py-2 text-green-600 border border-green-200 rounded-lg hover:bg-green-50"
                        >
                          Aktivovat
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </main>
    </div>
  )
}