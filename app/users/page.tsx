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
  role: string
  module: string
  can_view: boolean
  can_edit: boolean
  can_approve: boolean
}

const MODULES = [
  { key: 'my_shifts', label: 'Moje směny', hasApprove: false },
  { key: 'timesheet', label: 'Timesheet', hasApprove: false },
  { key: 'inventory', label: 'Zásoby', hasApprove: false },
  { key: 'shifts', label: 'Plánování směn', hasApprove: false },
  { key: 'approve', label: 'Schvalování', hasApprove: true },
  { key: 'users', label: 'Správa uživatelů', hasApprove: false },
]

const ROLES = [
  { key: 'manager', label: 'Manažer', color: 'purple', desc: 'Plný přístup ke všemu' },
  { key: 'provozni', label: 'Provozní', color: 'blue', desc: 'Správa směn, brigádníků a zásob' },
  { key: 'brigadnik', label: 'Brigádník', color: 'gray', desc: 'Přihlašování na směny, timesheet' },
]

function roleLabel(key: string): string {
  return ROLES.find(r => r.key === key)?.label || key
}

function roleColor(key: string): string {
  const r = ROLES.find(r => r.key === key)
  if (r?.color === 'purple') return 'bg-purple-100 text-purple-700'
  if (r?.color === 'blue') return 'bg-blue-100 text-blue-700'
  return 'bg-gray-100 text-gray-600'
}

function roleAvatarColor(key: string): string {
  const r = ROLES.find(r => r.key === key)
  if (r?.color === 'purple') return 'bg-purple-100 text-purple-700'
  if (r?.color === 'blue') return 'bg-blue-100 text-blue-700'
  return 'bg-gray-100 text-gray-700'
}

export default function UsersPage() {
  const [currentUser, setCurrentUser] = useState<any>(null)
  const [users, setUsers] = useState<User[]>([])
  const [rolePermissions, setRolePermissions] = useState<Permission[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [messageType, setMessageType] = useState<'ok' | 'err'>('ok')

  // Tabs
  const [activeTab, setActiveTab] = useState<'users' | 'roles'>('users')

  // Users tab state
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newUser, setNewUser] = useState({ email: '', name: '', role: 'brigadnik', hourly_rate: '0', bank_account: '' })

  const showMsg = (text: string, type: 'ok' | 'err' = 'ok') => {
    setMessage(text)
    setMessageType(type)
    setTimeout(() => setMessage(''), 4000)
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) { window.location.href = '/login'; return }
      setCurrentUser(user)
      loadData()
    })
  }, [])

  const loadData = async () => {
    const { data: usersData } = await supabase
      .from('users').select('*').is('deleted_at', null).order('created_at')
    if (usersData) setUsers(usersData)

    const { data: permsData } = await supabase
      .from('role_permissions').select('*')
    if (permsData) setRolePermissions(permsData)

    setLoading(false)
  }

  // ─── Users tab handlers ───────────────────────────────────
  const handleAddUser = async () => {
    if (!newUser.email.trim() || !newUser.name.trim()) return
    setSaving(true)

    const { data: authData } = await supabase.auth.admin.createUser({
      email: newUser.email.trim(), email_confirm: true,
    }).catch(() => ({ data: null }))

    const userId = authData?.user?.id || crypto.randomUUID()

    const { error } = await supabase.from('users').insert({
      id: userId, email: newUser.email.trim(), name: newUser.name.trim(),
      role: newUser.role, hourly_rate: parseFloat(newUser.hourly_rate) || 0,
      bank_account: newUser.bank_account.trim() || null,
    })

    if (error) { showMsg('Chyba: ' + error.message, 'err'); setSaving(false); return }

    setNewUser({ email: '', name: '', role: 'brigadnik', hourly_rate: '0', bank_account: '' })
    setShowAddForm(false)
    showMsg('Uživatel přidán')
    await loadData()
    setSaving(false)
  }

  const handleUpdateUser = async (userId: string, field: string, value: any) => {
    await supabase.from('users').update({ [field]: value }).eq('id', userId)
    await loadData()
  }

  const handleRoleChange = async (userId: string, newRole: string) => {
    await supabase.from('users').update({ role: newRole }).eq('id', userId)
    await loadData()
    showMsg('Role změněna')
  }

  const handleDeactivate = async (userId: string) => {
    await supabase.from('users').update({ is_active: false }).eq('id', userId)
    await loadData()
    showMsg('Uživatel deaktivován')
  }

  const handleActivate = async (userId: string) => {
    await supabase.from('users').update({ is_active: true }).eq('id', userId)
    await loadData()
    showMsg('Uživatel aktivován')
  }

  // ─── Roles tab handlers ───────────────────────────────────
  const getRolePerm = (role: string, module: string): Permission | undefined => {
    return rolePermissions.find(p => p.role === role && p.module === module)
  }

  const toggleRolePerm = async (role: string, module: string, field: 'can_view' | 'can_edit' | 'can_approve') => {
    const existing = getRolePerm(role, module)

    if (existing) {
      const newVal = !existing[field]
      const updates: Record<string, boolean> = { [field]: newVal }

      // Vypneš zobrazit → vypne se i upravit a schválit
      if (field === 'can_view' && !newVal) {
        updates.can_edit = false
        updates.can_approve = false
      }
      // Zapneš upravit nebo schválit → zapne se i zobrazit
      if ((field === 'can_edit' || field === 'can_approve') && newVal) {
        updates.can_view = true
      }

      await supabase.from('role_permissions').update(updates).eq('id', existing.id)
    } else {
      const newPerm: Record<string, any> = {
        role, module, can_view: false, can_edit: false, can_approve: false,
        [field]: true,
      }
      if (field === 'can_edit' || field === 'can_approve') newPerm.can_view = true
      await supabase.from('role_permissions').insert(newPerm)
    }

    await loadData()
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50"><p className="text-gray-500">Načítám...</p></div>
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

      {message && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${messageType === 'ok' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>
          {message}
        </div>
      )}

      <main className="max-w-5xl mx-auto px-4 py-6">
        {/* Tabs */}
        <div className="flex gap-1 mb-6 bg-gray-100 rounded-lg p-1 w-fit">
          <button onClick={() => setActiveTab('users')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${activeTab === 'users' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            Uživatelé
          </button>
          <button onClick={() => setActiveTab('roles')}
            className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${activeTab === 'roles' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
            Role a oprávnění
          </button>
        </div>

        {/* ═══════════════════════════════════════════════════ */}
        {/* TAB: Uživatelé                                      */}
        {/* ═══════════════════════════════════════════════════ */}
        {activeTab === 'users' && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
              <h2 className="text-xl font-semibold text-gray-900">Uživatelé</h2>
              <button onClick={() => setShowAddForm(!showAddForm)}
                className="text-sm px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700">
                + Přidat uživatele
              </button>
            </div>

            {/* Add form */}
            {showAddForm && (
              <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
                <h3 className="font-semibold text-gray-900 mb-4">Nový uživatel</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Jméno</label>
                    <input type="text" value={newUser.name}
                      onChange={e => setNewUser(p => ({ ...p, name: e.target.value }))}
                      placeholder="Jana Králová"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">E-mail</label>
                    <input type="email" value={newUser.email}
                      onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))}
                      placeholder="jana@email.cz"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                    <select value={newUser.role}
                      onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
                      {ROLES.map(r => <option key={r.key} value={r.key}>{r.label} — {r.desc}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">Hodinová sazba (Kč)</label>
                    <input type="number" value={newUser.hourly_rate}
                      onChange={e => setNewUser(p => ({ ...p, hourly_rate: e.target.value }))}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">Číslo účtu</label>
                    <input type="text" value={newUser.bank_account}
                      onChange={e => setNewUser(p => ({ ...p, bank_account: e.target.value }))}
                      placeholder="2345678901/0800"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <button onClick={handleAddUser} disabled={saving}
                    className="px-4 py-2 bg-orange-600 text-white text-sm rounded-lg hover:bg-orange-700 disabled:opacity-50">
                    {saving ? 'Ukládám...' : 'Vytvořit uživatele'}
                  </button>
                  <button onClick={() => setShowAddForm(false)}
                    className="px-4 py-2 bg-white border border-gray-300 text-sm rounded-lg hover:bg-gray-50">
                    Zrušit
                  </button>
                </div>
              </div>
            )}

            {/* Users list */}
            <div className="space-y-3">
              {users.map(user => {
                const isSelected = selectedUser?.id === user.id

                return (
                  <div key={user.id} className={`bg-white border rounded-lg ${!user.is_active ? 'opacity-60' : ''} ${isSelected ? 'border-orange-300' : 'border-gray-200'}`}>
                    <div className="px-6 py-4 flex flex-col sm:flex-row sm:items-center gap-4 cursor-pointer"
                      onClick={() => setSelectedUser(isSelected ? null : user)}>
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium ${roleAvatarColor(user.role)}`}>
                          {user.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                        </div>
                        <div className="min-w-0">
                          <div className="font-medium text-gray-900 truncate">{user.name}</div>
                          <div className="text-sm text-gray-500 truncate">{user.email}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-xs px-2 py-1 rounded-full font-medium ${roleColor(user.role)}`}>
                          {roleLabel(user.role)}
                        </span>
                        <span className="text-sm text-gray-500">{user.hourly_rate} Kč/h</span>
                        {user.bank_account && <span className="text-xs text-gray-400">{user.bank_account}</span>}
                        {!user.is_active && <span className="text-xs px-2 py-1 bg-red-100 text-red-600 rounded-full">Neaktivní</span>}
                        <span className="text-gray-400 text-sm">{isSelected ? '▲' : '▼'}</span>
                      </div>
                    </div>

                    {isSelected && (
                      <div className="px-6 py-4 border-t border-gray-200 space-y-5" onClick={e => e.stopPropagation()}>
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Jméno</label>
                            <input type="text" defaultValue={user.name}
                              onBlur={e => handleUpdateUser(user.id, 'name', e.target.value)}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Hodinová sazba (Kč)</label>
                            <input type="number" defaultValue={user.hourly_rate}
                              onBlur={e => handleUpdateUser(user.id, 'hourly_rate', parseFloat(e.target.value))}
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          </div>
                          <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">Číslo účtu</label>
                            <input type="text" defaultValue={user.bank_account || ''}
                              onBlur={e => handleUpdateUser(user.id, 'bank_account', e.target.value || null)}
                              placeholder="2345678901/0800"
                              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm" />
                          </div>
                        </div>

                        {/* Role selection */}
                        <div>
                          <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
                          <div className="flex flex-wrap gap-2">
                            {ROLES.map(role => (
                              <button key={role.key}
                                onClick={() => handleRoleChange(user.id, role.key)}
                                className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                                  user.role === role.key
                                    ? 'bg-orange-50 border-orange-300 text-orange-700'
                                    : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                                }`}>
                                <span className="font-medium">{role.label}</span>
                                <span className="text-xs ml-1 text-gray-500">— {role.desc}</span>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-3 pt-1">
                          {user.is_active ? (
                            <button onClick={() => handleDeactivate(user.id)}
                              className="text-sm px-4 py-2 text-red-600 border border-red-200 rounded-lg hover:bg-red-50">
                              Deaktivovat
                            </button>
                          ) : (
                            <button onClick={() => handleActivate(user.id)}
                              className="text-sm px-4 py-2 text-green-600 border border-green-200 rounded-lg hover:bg-green-50">
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
          </>
        )}

        {/* ═══════════════════════════════════════════════════ */}
        {/* TAB: Role a oprávnění                               */}
        {/* ═══════════════════════════════════════════════════ */}
        {activeTab === 'roles' && (
          <>
            <h2 className="text-xl font-semibold text-gray-900 mb-2">Role a oprávnění</h2>
            <p className="text-sm text-gray-500 mb-6">Nastavení přístupu k modulům podle role. Změny se projeví u všech uživatelů s danou rolí.</p>

            <div className="space-y-6">
              {ROLES.map(role => {
                const usersWithRole = users.filter(u => u.role === role.key && u.is_active)

                return (
                  <div key={role.key} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    {/* Role header */}
                    <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${roleColor(role.key)}`}>
                          {role.label}
                        </span>
                        <span className="text-sm text-gray-500">{role.desc}</span>
                      </div>
                      <div className="flex items-center gap-1">
                        {usersWithRole.slice(0, 5).map(u => (
                          <div key={u.id} className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium ${roleAvatarColor(role.key)} border-2 border-white -ml-1 first:ml-0`}
                            title={u.name}>
                            {u.name.split(' ').map(n => n[0]).join('').slice(0, 2)}
                          </div>
                        ))}
                        {usersWithRole.length > 5 && (
                          <span className="text-xs text-gray-400 ml-1">+{usersWithRole.length - 5}</span>
                        )}
                        {usersWithRole.length === 0 && (
                          <span className="text-xs text-gray-400">žádní uživatelé</span>
                        )}
                      </div>
                    </div>

                    {/* Permissions table */}
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-50">
                          <th className="text-left px-6 py-2.5 font-medium text-gray-500">Modul</th>
                          <th className="text-center px-4 py-2.5 font-medium text-gray-500 w-28">Zobrazit</th>
                          <th className="text-center px-4 py-2.5 font-medium text-gray-500 w-28">Upravit</th>
                          <th className="text-center px-4 py-2.5 font-medium text-gray-500 w-28">Schválit</th>
                        </tr>
                      </thead>
                      <tbody>
                        {MODULES.map(mod => {
                          const perm = getRolePerm(role.key, mod.key)
                          return (
                            <tr key={mod.key} className="border-t border-gray-100 hover:bg-gray-50/50">
                              <td className="px-6 py-3 text-gray-900">{mod.label}</td>
                              <td className="px-4 py-3 text-center">
                                <input type="checkbox" checked={perm?.can_view || false}
                                  onChange={() => toggleRolePerm(role.key, mod.key, 'can_view')}
                                  className="w-4 h-4 text-orange-600 rounded cursor-pointer" />
                              </td>
                              <td className="px-4 py-3 text-center">
                                <input type="checkbox" checked={perm?.can_edit || false}
                                  onChange={() => toggleRolePerm(role.key, mod.key, 'can_edit')}
                                  className="w-4 h-4 text-orange-600 rounded cursor-pointer" />
                              </td>
                              <td className="px-4 py-3 text-center">
                                {mod.hasApprove ? (
                                  <input type="checkbox" checked={perm?.can_approve || false}
                                    onChange={() => toggleRolePerm(role.key, mod.key, 'can_approve')}
                                    className="w-4 h-4 text-orange-600 rounded cursor-pointer" />
                                ) : (
                                  <span className="text-gray-300">—</span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>
    </div>
  )
}