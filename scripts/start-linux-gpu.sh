#!/usr/bin/env bash
# Start the source app with the CUDA 13 libraries used by ONNX Runtime.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
workspace="$(dirname "$root")"
python="$workspace/build-python/bin/python"
[[ -x $python ]] || { echo 'Run Setup-OGAD-Source.sh first.' >&2; exit 1; }

site="$("$python" -c 'import site; print(site.getsitepackages()[0])')"
cublas_lib="$site/nvidia/cublas/lib"
cuda_runtime_lib="$site/nvidia/cuda_runtime/lib"
curand_lib="$site/nvidia/curand/lib"
cudnn_lib="$site/nvidia/cudnn/lib"
for library in "$cublas_lib/libcublas.so.13" "$cublas_lib/libcublasLt.so.13" \
  "$cuda_runtime_lib/libcudart.so.13" "$curand_lib/libcurand.so.10" \
  "$cudnn_lib/libcudnn.so.9"; do
  [[ -f $library ]] || { echo "Missing ONNX CUDA library: $library" >&2; exit 1; }
done

export LD_LIBRARY_PATH="$cublas_lib:$cuda_runtime_lib:$curand_lib:$cudnn_lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export OFFGRID_FORCE_CORE=0
cd "$root"
exec npm run dev
