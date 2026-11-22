import { defineConfig } from "vite";

export default defineConfig({
  base: "/Gta6Voice/",
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0
  },
  worker: {
    format: "es"
  }
});
