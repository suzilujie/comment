/**
 * 管理台登录页。
 *
 * 凭据由**后端**校验（默认 admin/admin，可用 ADMIN_USERNAME / ADMIN_PASSWORD 覆盖），
 * 前端不硬编码任何密码 —— 这里只负责收集输入、展示错误、登录成功后写 token。
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api'

export default function Login({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || !username || !password) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.login(username.trim(), password)
      onSuccess(r.username)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败')
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  const inputCls =
    'mt-1 w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none transition focus:border-sky-700'

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/60 p-6 shadow-2xl"
      >
        <h1 className="text-lg font-semibold text-slate-100">评论投放 · 管理台</h1>
        <p className="mt-1 text-xs text-slate-500">请登录后使用</p>

        <label className="mt-6 block text-xs text-slate-400">
          用户名
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className={inputCls}
          />
        </label>

        <label className="mt-4 block text-xs text-slate-400">
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className={inputCls}
          />
        </label>

        {err && (
          <div className="mt-4 rounded-lg border border-rose-800/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="mt-6 w-full rounded-md border border-sky-700 bg-sky-900/70 px-3 py-2 text-sm font-medium text-sky-100 transition hover:bg-sky-800/80 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </div>
  )
}
