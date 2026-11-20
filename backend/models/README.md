# models/

`realesr-general-x4v3.onnx` — Real-ESRGAN General x4v3 (xinntao/Real-ESRGAN, BSD-3-Clause), converted to ONNX
(source: huggingface.co/vlad-grig/realesr-general-x4v3-onnx, `onnx/model.onnx`,
sha256 7b10e80021ec3e0ff35017ae5022791879d93a799b2e201e1010a37510202266). Input `input` [1,3,H,W] RGB 0..1,
output `output` [1,3,4H,4W]. Used by lib/upscale.js to enlarge AI artwork before the print render.
The upscaler does not run unless `UPSCALE_ARTWORK=on` (a full scene is too slow to do on every order inside the 300s function limit). `UPSCALE_ARTWORK=off` keeps it off. `UPSCALE_BUDGET_MS` (default 160000) is the time one order may spend upscaling before the original artwork is printed instead.
