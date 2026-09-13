import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  base: "./",
  plugins: [vue()],
  clearScreen: false,
  server: {
    strictPort: true,
    host: "127.0.0.1",
    port: 1420,
  },
  envPrefix: ["VITE_", "ELECTRON_"],
  build: {
    target: ["chrome111", "safari15"],
    minify: process.env.ELECTRON_RENDERER_DEBUG ? false : "oxc",
    sourcemap: Boolean(process.env.ELECTRON_RENDERER_DEBUG),
  },
});
