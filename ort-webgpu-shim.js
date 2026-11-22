// Load ONNX Runtime's dedicated native WebGPU bundle for PaddleOCR.js.
// The normal "onnxruntime-web" entry does not select this build explicitly.
import * as ort from "onnxruntime-web/webgpu";

// Prefer the physical GPU for inference. This is only a hint to the browser.
try {
  if (ort.env?.webgpu) {
    ort.env.webgpu.powerPreference = "high-performance";
  }
} catch (error) {
  console.warn("Could not set WebGPU power preference:", error);
}

export * from "onnxruntime-web/webgpu";
