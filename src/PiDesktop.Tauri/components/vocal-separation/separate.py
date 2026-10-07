import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import uuid


def data_root() -> pathlib.Path:
    configured = os.environ.get("SYNTHV_TOOLBOX_DATA_ROOT")
    if not configured:
        raise RuntimeError("SYNTHV_TOOLBOX_DATA_ROOT is required")
    root = pathlib.Path(configured).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    return root


def select_device(torch):
    mode = os.environ.get("SYNTHV_TOOLBOX_SEPARATION_DEVICE", "auto").strip().lower() or "auto"
    if mode == "cpu":
        return "cpu"
    if mode != "auto":
        raise ValueError("SYNTHV_TOOLBOX_SEPARATION_DEVICE must be 'auto' or 'cpu'.")
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps"
    raise RuntimeError("No supported hardware backend is available for Demucs; CPU requires explicit test override.")


def separate(source_text: str, output_id_text: str | None = None) -> dict:
    requested_source = pathlib.Path(source_text).expanduser()
    if not requested_source.is_absolute():
        raise ValueError("输入音频路径必须是绝对路径")
    if requested_source.is_symlink():
        raise ValueError("输入必须是存在且非符号链接的本地音频文件")
    source = requested_source.resolve()
    if not source.is_file():
        raise ValueError("输入必须是存在且非符号链接的本地音频文件")
    if source.suffix.lower() not in {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus"}:
        raise ValueError("输入音频格式不受支持")

    import torch

    device = select_device(torch)
    root = data_root()
    output_id = str(uuid.UUID(output_id_text)) if output_id_text else str(uuid.uuid4())
    output = root / "output" / "separations" / output_id
    raw = output / "raw"
    output.mkdir(parents=True, exist_ok=False)
    command = [
        sys.executable, "-m", "demucs", "--two-stems", "vocals", "--name", "htdemucs",
        "--device", device, "--out", str(raw), str(source),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if completed.returncode != 0:
            raise RuntimeError(completed.stderr[-3000:] or completed.stdout[-1000:] or "Demucs 分离失败")

        candidates = list(raw.glob("htdemucs/*/vocals.wav"))
        if len(candidates) != 1:
            raise RuntimeError("Demucs 没有生成唯一的人声轨")
        vocal_source = candidates[0]
        instrumental_source = vocal_source.with_name("no_vocals.wav")
        if not instrumental_source.is_file():
            raise RuntimeError("Demucs 没有生成伴奏轨")

        vocal = output / "vocals.wav"
        instrumental = output / "instrumental.wav"
        shutil.copy2(vocal_source, vocal)
        shutil.copy2(instrumental_source, instrumental)
        if vocal.stat().st_size == 0 or instrumental.stat().st_size == 0:
            raise RuntimeError("Demucs 输出轨为空")
        shutil.rmtree(raw, ignore_errors=True)
        return {
            "separationId": output_id,
            "sourcePath": str(source),
            "vocalPath": str(vocal),
            "instrumentalPath": str(instrumental),
            "model": "htdemucs",
            "device": device,
        }
    except BaseException:
        shutil.rmtree(output, ignore_errors=True)
        raise


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--output-id")
    args = parser.parse_args()
    try:
        print(json.dumps(separate(args.source, args.output_id), ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
