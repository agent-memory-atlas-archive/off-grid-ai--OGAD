#!/usr/bin/env python3
"""Stage pinned Windows ONNX CUDA files for the optional performance pack."""

from pathlib import Path
from zipfile import ZipFile
import hashlib
import json
import shutil
import sys

ORT_ARCHIVE_SHA256 = "d4667ea48eb0a10bc9b96b838f7b8975a6bf18de3bc5edd403a22e15c1458b23"
BINDING_SHA256 = "c658fdb8db34f3dda9c9a19db996858ac127db94999c10be777b93694c275515"
ORT_PREFIX = "onnxruntime-win-x64-gpu_cuda12-1.30.0/"
# NVIDIA wheel versions and hashes live in resources/engine-pins.json (nvidia.win).
PINS = json.loads((Path(__file__).resolve().parent.parent / "resources" / "engine-pins.json").read_text())
WHEELS = {
    f"{name.replace('-', '_')}-{pin['version']}-py3-none-win_amd64.whl": pin["sha256"]
    for name, pin in PINS["nvidia"]["win"].items()
}
ORT_DLLS = (
    "onnxruntime.dll",
    "onnxruntime_providers_cuda.dll",
    "onnxruntime_providers_shared.dll",
)
REQUIRED_DLLS = (
    "cublasLt64_12.dll",
    "cublas64_12.dll",
    "cudart64_12.dll",
    "cudnn64_9.dll",
    "cufft64_11.dll",
    "nvrtc64_120_0.dll",
)


def verify(path: Path, expected: str) -> None:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    if digest.hexdigest() != expected:
        raise ValueError(f"SHA256 mismatch: {path}")


def extract_file(archive: ZipFile, member: str, destination: Path) -> None:
    with archive.open(member) as source, destination.open("wb") as target:
        shutil.copyfileobj(source, target)


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("Usage: stage-win-onnx-cuda-pack.py <ort-zip> <wheel-dir> <binding.node> <output-dir>")
    ort_zip, wheel_dir, binding, output = map(Path, sys.argv[1:])
    verify(ort_zip, ORT_ARCHIVE_SHA256)
    verify(binding, BINDING_SHA256)
    output.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(binding, output / "onnxruntime_binding.node")
    with ZipFile(ort_zip) as archive:
        for name in ORT_DLLS:
            extract_file(archive, f"{ORT_PREFIX}lib/{name}", output / name)
        extract_file(archive, f"{ORT_PREFIX}LICENSE", output / "LICENSE-onnxruntime")

    for name, sha256 in WHEELS.items():
        wheel = wheel_dir / name
        verify(wheel, sha256)
        with ZipFile(wheel) as archive:
            for member in archive.namelist():
                if member.lower().endswith(".dll"):
                    extract_file(archive, member, output / Path(member).name)
                elif member.endswith("/License.txt"):
                    extract_file(archive, member, output / f"LICENSE-{name.removesuffix('.whl')}.txt")

    for name in ORT_DLLS + REQUIRED_DLLS:
        if not (output / name).is_file():
            raise FileNotFoundError(output / name)
    print(f"Windows ONNX CUDA files staged in {output}")


if __name__ == "__main__":
    main()
