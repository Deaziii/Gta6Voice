import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const ortWebGpuShim = fileURLToPath(new URL("./ort-webgpu-shim.js", import.meta.url));

export default defineConfig({
  base: "/Gta6Voice/",
  resolve: {
    // PaddleOCR.js imports the default ONNX Runtime entry. Route that import
    // to the dedicated native WebGPU build instead of the legacy default bundle.
    alias: [
      {
        find: /^onnxruntime-web$/,
        replacement: ortWebGpuShim
      }
    ]
  },
  build: {
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0
  },
  worker: {
    format: "es"
  }
});
