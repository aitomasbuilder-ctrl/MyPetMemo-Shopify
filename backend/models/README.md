# models/

`realesr-general-x4v3.onnx` — Real-ESRGAN General x4v3 (xinntao/Real-ESRGAN, BSD-3-Clause), converted to ONNX
(source: huggingface.co/vlad-grig/realesr-general-x4v3-onnx, `onnx/model.onnx`,
sha256 7b10e80021ec3e0ff35017ae5022791879d93a799b2e201e1010a37510202266). Input `input` [1,3,H,W] RGB 0..1,
output `output` [1,3,4H,4W]. Used by lib/upscale.js to enlarge AI artwork before the print render.
The upscaler does not run unless `UPSCALE_ARTWORK=on` (a full scene is too slow to do on every order inside the 300s function limit). `UPSCALE_ARTWORK=off` keeps it off. `UPSCALE_BUDGET_MS` (default 160000) is the time one order may spend upscaling before the original artwork is printed instead.

`silueta.onnx` — modified U²-Net (Xuebin Qin et al., Apache-2.0), the rembg `silueta` checkpoint
(github.com/danielgatis/rembg release v0.0.0, md5 55e59e0d8062d2f5d013f4725ee84782,
sha256 75da6c8d2f8096ec743d071951be73b4a8bc7b3e51d9a6625d63644f90ffeedb). Input `input.1` [1,3,320,320]
ImageNet-normalised RGB, output a 320×320 matte. Used by `api/cutout.js`, then refined at the photo's
size. The 214 MB BiRefNet-general-lite network is not shipped: its 1024×1024 forward pass is killed
at a 2048 MB limit. Silueta's forward pass stays under about 700 MB.
