import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Same-origin in dev: the browser talks to Vite, Vite talks to the gateway.
    proxy: {
      "/v1": { target: "http://127.0.0.1:8900", ws: true, changeOrigin: true },
    },
  },
});
