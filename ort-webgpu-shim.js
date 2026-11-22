// PaddleOCR.js creates detection and recognition sessions in this order.
 // Keep DB text detection on the proven WASM path on this Android device, while
 // allowing the much heavier character-recognition session to use native WebGPU.
import * as ort from "onnxruntime-web/webgpu";

try {
  if (ort.env?.webgpu) {
    ort.env.webgpu.powerPreference = "high-performance";
  }
} catch (error) {
  console.warn("Could not set WebGPU power preference:", error);
}

let sessionCreateIndex = 0;
const NativeInferenceSession = ort.InferenceSession;

export const InferenceSession = {
  create(model, options = {}) {
    const callIndex = sessionCreateIndex++;
    const providers = options.executionProviders;
    if (
      callIndex === 0 &&
      Array.isArray(providers) &&
      providers[0] === "webgpu"
    ) {
      // Mutate the candidate array as well, so PaddleOCR.js reports the actual
      // provider and does not mistake the successful WASM session for WebGPU.
      providers[0] = "wasm";
      console.info("[GTA6 Voice] Hybrid OCR: detector=WASM, recognizer=WebGPU");
    }
    return NativeInferenceSession.create.call(NativeInferenceSession, model, options);
  }
};

export * from "onnxruntime-web/webgpu";
