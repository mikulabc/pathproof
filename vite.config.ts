import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { middlewareMode: true },
  build: { outDir: 'dist' },
});
