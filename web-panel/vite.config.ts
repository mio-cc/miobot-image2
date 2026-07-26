import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 直接产出到 apps/panel/static/admin —— 启动器就从那里静态托管 /admin/，
// 少一步手工拷贝也就少一个"构建了但线上还是旧版"的坑。
export default defineConfig({
  base: '/admin/',
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('../apps/panel/static/admin', import.meta.url)),
    emptyOutDir: true,
  },
})
