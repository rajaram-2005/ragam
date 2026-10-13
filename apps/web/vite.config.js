import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server binds 0.0.0.0 and accepts any host so it works behind a
// container port-forward or a preview proxy. The backend is reached through the
// /api proxy, never by an absolute URL from the browser: the browser is not the
// sandbox, so a hard-coded localhost would point at the user's own machine.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT || 5173),
    allowedHosts: true,
    strictPort: false,
    proxy: {
      '/api': {
        target: process.env.AETHERIS_CORE_URL || 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT || 5173),
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.AETHERIS_CORE_URL || 'http://127.0.0.1:8790',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // Fail the build on chunks large enough to hide an accidental dependency.
    chunkSizeWarningLimit: 600,
  },
})
