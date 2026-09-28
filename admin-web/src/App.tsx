import { useEffect, useState } from 'react'
import Login from './Login'
import Cities from './pages/Cities'
import Commands from './pages/Commands'
import Devices from './pages/Devices'
import Events from './pages/Events'
import Materials from './pages/Materials'
import Overview from './pages/Overview'
import Posts from './pages/Posts'
import Scripts from './pages/Scripts'
import Tasks from './pages/Tasks'
import { getToken, logout, setUnauthorizedHandler } from './api'
import { Btn, ToastHost, useToasts } from './ui'

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'devices', label: '设备' },
  { key: 'tasks', label: '任务' },
  { key: 'posts', label: '帖子池' },
  { key: 'materials', label: '素材' },
  { key: 'scripts', label: '话术' },
  { key: 'cities', label: '省份池' },
  { key: 'commands', label: '指令' },
  { key: 'events', label: '事件流' },
] as const

type TabKey = (typeof TABS)[number]['key']

export default function App() {
  // 先用本地 token 判断初始登录态，避免刷新页面时闪一下登录页
  const [loggedIn, setLoggedIn] = useState(() => getToken() !== null)
  const [tab, setTab] = useState<TabKey>('overview')
  const [autoMs, setAutoMs] = useState(15000)
  const [refreshKey, setRefreshKey] = useState(0)
  const { items, push } = useToasts()

  // 任意请求收到 401（token 过期 / 服务端换了密钥）→ 回登录页
  useEffect(() => {
    setUnauthorizedHandler(() => setLoggedIn(false))
    return () => setUnauthorizedHandler(null)
  }, [])

  const common = { autoMs, refreshKey, notify: push }

  if (!loggedIn) return <Login onSuccess={() => setLoggedIn(true)} />

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-slate-100">评论投放 · 管理台</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            监控：概览 / 设备 / 任务 / 事件流 · 配置：帖子池 / 素材 / 话术 / 省份池 · 运维：指令下发
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-500">自动刷新</label>
          <select
            value={autoMs}
            onChange={(e) => setAutoMs(Number(e.target.value))}
            className="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-200"
          >
            <option value={0}>关闭</option>
            <option value={10000}>10 秒</option>
            <option value={15000}>15 秒</option>
            <option value={30000}>30 秒</option>
            <option value={60000}>60 秒</option>
          </select>
          <Btn onClick={() => setRefreshKey((k) => k + 1)}>立即刷新</Btn>
          <Btn
            tone="ghost"
            onClick={() => {
              logout()
              setLoggedIn(false)
            }}
          >
            退出登录
          </Btn>
        </div>
      </header>

      <nav className="flex flex-wrap gap-1 border-b border-slate-800 pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              tab === t.key
                ? 'bg-slate-800 text-slate-100'
                : 'text-slate-500 hover:bg-slate-800/50 hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex-1">
        {tab === 'overview' && <Overview {...common} />}
        {tab === 'devices' && <Devices {...common} />}
        {tab === 'tasks' && <Tasks {...common} />}
        {tab === 'posts' && <Posts {...common} />}
        {tab === 'materials' && <Materials {...common} />}
        {tab === 'scripts' && <Scripts {...common} />}
        {tab === 'cities' && <Cities {...common} />}
        {tab === 'commands' && <Commands {...common} />}
        {tab === 'events' && <Events {...common} />}
      </main>

      <footer className="pb-4 text-center text-[11px] text-slate-600">
        comment/admin-web · 独立前端（dev: vite proxy → 后端 15650）
      </footer>

      <ToastHost items={items} />
    </div>
  )
}
