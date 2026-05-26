import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/report.html': 'http://localhost:8787',
      '/comparisons': 'http://localhost:8787',
    },
  },
});
