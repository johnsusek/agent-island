import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The Vue dashboard lives in web/ and builds to dist/web, which the Express
// server serves statically. In dev, `vite` runs its own server with HMR and
// proxies the API and MCP routes to the Express process on :3000.
export default defineConfig({
  root: fileURLToPath(new URL("./web", import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL("./dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: process.env.PORT ? Number(process.env.PORT) : undefined,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/mcp": "http://127.0.0.1:3000",
    },
  },
});
