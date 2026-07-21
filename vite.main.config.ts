import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Externalize native modules that can't be bundled
      external: [
        'node-global-key-listener',
      ],
    },
  },
});
