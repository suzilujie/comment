import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 开发期把 /api 与 /health 代理到后端，前端代码统一使用相对路径，
 * 这样 dev（代理）与生产（反向代理同域）两种部署都不需要改代码、也没有跨域问题。
 *
 * 后端不在本机时，改下面的 BACKEND 即可（保持为常量，避免引入 @types/node 依赖）。
 */
const BACKEND = 'http://127.0.0.1:15650'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 监听所有网卡：既方便本机用 127.0.0.1 访问，也便于同局域网手机/平板查看
    host: true,
    port: 5273,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
    },
  },
  preview: { port: 5273 },
  build: { outDir: 'dist', sourcemap: false },
})
