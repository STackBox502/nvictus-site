#!/usr/bin/env python3
"""Jarvis local wake-word helper (openWakeWord, ONNX).

Isolated child process. It never opens the network at runtime, never runs shell commands, and
never writes files (except during the explicit --download-models setup step).

Protocol
  stdin  : repeated binary frames: 4-byte little-endian unsigned length N, then N bytes of
           16 kHz mono signed 16-bit little-endian PCM. N must be even and <= 32000.
           N == 0 means "shut down cleanly".
  stdout : one JSON object per line, only these types:
           {"type":"ready","models":[...]}
           {"type":"detect","model":"hey_jarvis","score":0.83}
           {"type":"selftest","ok":true,"max_score_silence":0.0,"models":[...]}
           {"type":"downloaded","models":[...]}
           {"type":"error","message":"..."}
  stderr : diagnostics only.

Licensing: openWakeWord code is Apache-2.0. Its pre-trained models (including "hey_jarvis") are
CC BY-NC-SA 4.0 (non-commercial). Personal use only; do not redistribute them in a commercial product.
"""
import argparse
import json
import struct
import sys
import time

FRAME_SAMPLES = 1280  # 80 ms at 16 kHz, as recommended by openWakeWord
MAX_FRAME_BYTES = 32000


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read_exact(stream, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf.extend(chunk)
    return bytes(buf)


def load_model(args):
    from openwakeword.model import Model

    target = args.model_path if args.model_path else args.model
    return Model(wakeword_models=[target], inference_framework="onnx")


def main():
    p = argparse.ArgumentParser(description="Jarvis local wake-word helper")
    p.add_argument("--threshold", type=float, default=0.5)
    p.add_argument("--model", default="hey_jarvis", help="Built-in openWakeWord model name")
    p.add_argument("--model-path", default="", help="Path to a custom compatible .onnx wake-word model")
    p.add_argument("--cooldown-ms", type=int, default=1500)
    p.add_argument("--download-models", action="store_true", help="One-time setup: download the model files")
    p.add_argument("--self-test", action="store_true", help="Load the model and score silence, then exit")
    args = p.parse_args()

    if not 0.05 <= args.threshold <= 0.99:
        emit({"type": "error", "message": "threshold out of range"})
        return 2

    if args.download_models:
        try:
            from openwakeword.utils import download_models

            download_models(model_names=[args.model])
            emit({"type": "downloaded", "models": [args.model]})
            return 0
        except Exception as exc:  # noqa: BLE001
            emit({"type": "error", "message": f"download failed: {exc}"[:300]})
            return 2

    try:
        import numpy as np

        model = load_model(args)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "error", "message": f"model load failed: {exc}"[:300]})
        return 2

    names = list(model.models.keys())

    if args.self_test:
        silence = np.zeros(FRAME_SAMPLES, dtype=np.int16)
        peak = 0.0
        for _ in range(25):
            scores = model.predict(silence)
            peak = max(peak, max(float(v) for v in scores.values()))
        emit({"type": "selftest", "ok": True, "max_score_silence": round(peak, 4), "models": names})
        return 0

    emit({"type": "ready", "models": names})
    stdin = sys.stdin.buffer
    pending = np.zeros(0, dtype=np.int16)
    last_detect = 0.0
    while True:
        header = read_exact(stdin, 4)
        if header is None:
            break
        (n,) = struct.unpack("<I", header)
        if n == 0:
            break
        if n > MAX_FRAME_BYTES or n % 2:
            emit({"type": "error", "message": "invalid frame length"})
            return 2
        data = read_exact(stdin, n)
        if data is None:
            break
        pending = np.concatenate([pending, np.frombuffer(data, dtype="<i2")])
        while len(pending) >= FRAME_SAMPLES:
            frame, pending = pending[:FRAME_SAMPLES], pending[FRAME_SAMPLES:]
            scores = model.predict(frame)
            now = time.monotonic() * 1000.0
            for name, score in scores.items():
                if float(score) >= args.threshold and now - last_detect >= args.cooldown_ms:
                    last_detect = now
                    emit({"type": "detect", "model": name, "score": round(float(score), 3)})
                    model.reset()
                    break
    return 0


if __name__ == "__main__":
    sys.exit(main())
