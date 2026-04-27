'use client'

import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export default function HomePage() {
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUser(user)
      setLoading(false)
    })
  }, [])

  const handleLogout = async () => {
    await supabase.auth.signOut()
    window.location.href = '/login'
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-gray-500">Načítám...</p>
      </div>
    )
  }

  if (!user) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login'
    }
    return null
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <h1 className="text-lg font-bold text-gray-900">Saluty</h1>
          <div className="flex items-center gap-4">
            <span className="text-sm text-gray-500">{user.email}</span>
            <button
              onClick={handleLogout}
              className="text-sm text-red-600 hover:text-red-700"
            >
              Odhlásit
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-8">
        <h2 className="text-xl font-semibold text-gray-900 mb-6">Dashboard</h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <a href="/shifts" className="block bg-white rounded-lg border border-gray-200 p-6 hover:border-orange-300 transition-colors">
            <div className="text-2xl mb-2">📅</div>
            <h3 className="font-semibold text-gray-900">Směny</h3>
            <p className="text-sm text-gray-500 mt-1">Přihlášení na volné směny</p>
          </a>

          <a href="/timesheet" className="block bg-white rounded-lg border border-gray-200 p-6 hover:border-orange-300 transition-colors">
            <div className="text-2xl mb-2">⏱️</div>
            <h3 className="font-semibold text-gray-900">Timesheet</h3>
            <p className="text-sm text-gray-500 mt-1">Výkaz odpracovaných hodin</p>
          </a>

          <a href="/inventory" className="block bg-white rounded-lg border border-gray-200 p-6 hover:border-orange-300 transition-colors">
            <div className="text-2xl mb-2">📦</div>
            <h3 className="font-semibold text-gray-900">Zásoby</h3>
            <p className="text-sm text-gray-500 mt-1">Evidence stavu zásob</p>
          </a>
        </div>
      </main>
    </div>
  )
}