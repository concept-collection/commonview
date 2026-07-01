import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // Project pages are served from https://<org>.github.io/commonview/
  base: '/commonview/',
  plugins: [react()]
})
