# models/

`realesr-general-x4v3.onnx` — Real-ESRGAN General x4v3 (xinntao/Real-ESRGAN, BSD-3-Clause), converted to ONNX
(source: huggingface.co/vlad-grig/realesr-general-x4v3-onnx, `onnx/model.onnx`,
sha256 7b10e80021ec3e0ff35017ae5022791879d93a799b2e201e1010a37510202266). Input `input` [1,3,H,W] RGB 0..1,
output `output` [1,3,4H,4W]. Used by lib/upscale.js to enlarge AI artwork before the print render.
The upscaler does not run unless `UPSCALE_ARTWORK=on` (a full scene is too slow to do on every order inside the 300s function limit). `UPSCALE_ARTWORK=off` keeps it off. `UPSCALE_BUDGET_MS` (default 160000) is the time one order may spend upscaling before the original artwork is printed instead.

`u2netp.onnx` — U²-Net portable (Xuebin Qin et al., Apache-2.0), the rembg `u2netp` checkpoint
(github.com/danielgatis/rembg release v0.0.0, md5 8e83ca70e441ab06c318d82300c84806,
sha256 309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8). Input `input.1` [1,3,320,320]
ImageNet-normalised RGB, output a 320×320 matte. Used by `api/cutout.js`. The 214 MB BiRefNet-general-lite
network is not shipped: its 1024×1024 forward pass is killed at a 2048 MB limit.
