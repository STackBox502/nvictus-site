"""Fixed stdin PCM protocol: 16 kHz mono int16, 1280 samples per prediction.
No network, files outside supplied model directory, microphone, or arbitrary commands.
Only READY/WAKE/ERROR are written to stdout.
"""
import sys
from pathlib import Path
try:
    import numpy as np
    from openwakeword.model import Model
    root = Path(sys.argv[1]).resolve()
    threshold = min(.95, max(.3, float(sys.argv[2])))
    model = Model(wakeword_models=[str(root / 'hey_jarvis_v0.1.onnx')], inference_framework='onnx',
                  melspec_model_path=str(root / 'melspectrogram.onnx'),
                  embedding_model_path=str(root / 'embedding_model.onnx'))
    print('READY', flush=True)
    while True:
        data = sys.stdin.buffer.read(2560)
        if len(data) != 2560:
            break
        scores = model.predict(np.frombuffer(data, dtype='<i2'))
        if max(scores.values(), default=0) >= threshold:
            print('WAKE', flush=True)
            model.reset()
except Exception:
    print('ERROR', flush=True)
    sys.exit(1)
