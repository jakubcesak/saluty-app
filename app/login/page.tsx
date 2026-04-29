'use client'

import { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'


export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('error=unauthorized')) {
      setError('Nemáte oprávnění k přístupu. Kontaktujte administrátora.')
    }
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: `${window.location.origin}/`,
      },
    })

    if (error) {
      setError('Nepodařilo se odeslat přihlašovací odkaz. Zkuste to znovu.')
    } else {
      setSent(true)
    }
    setLoading(false)
  }

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
        <div className="max-w-sm w-full text-center">
          <div className="text-4xl mb-4">📧</div>
          <h1 className="text-xl font-semibold text-gray-900 mb-2">
            Zkontrolujte e-mail
          </h1>
          <p className="text-gray-600 text-sm">
            Na adresu <strong>{email}</strong> jsme odeslali přihlašovací odkaz.
            Klikněte na něj pro přihlášení.
          </p>
          <button
            onClick={() => setSent(false)}
            className="mt-6 text-sm text-orange-600 hover:text-orange-700"
          >
            Zkusit jiný e-mail
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-sm w-full">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Saluti</h1>
          <p className="text-gray-500 text-sm mt-1">Přihlaste se e-mailem</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              E-mail
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="vas@email.cz"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
            />
          </div>

          {error && (
            <p className="text-red-600 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2 px-4 bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Odesílám...' : 'Odeslat přihlašovací odkaz'}
          </button>
        </form>

        <p className="text-center text-xs text-gray-400 mt-6">
          Na váš e-mail přijde odkaz, heslo nepotřebujete.
        </p>
      </div>
    </div>
  )
}