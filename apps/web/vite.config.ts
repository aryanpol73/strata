import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { version } from '../../package.json';

const backend = process.env.VITE_BACKEND ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: false },
      '/socket.io': { target: backend, ws: true },
    },
  },
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { sourcemap: true },
});
