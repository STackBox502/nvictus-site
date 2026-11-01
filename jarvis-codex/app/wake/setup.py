"""Explicit optional setup. Downloads only Python packages and three named models.
Run with --target <directory> to install in the packaged app's isolated user data.
No microphone, credentials or paid APIs are used by setup.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import urllib.request
import venv

parser = argparse.ArgumentParser()
parser.add_argument('--target', type=Path, default=Path(__file__).parent)
args = parser.parse_args()
target = args.target.resolve()
target.mkdir(parents=True, exist_ok=True)
runtime = target / '.venv'
if not (runtime / 'Scripts' / 'python.exe').exists():
    venv.EnvBuilder(with_pip=True).create(runtime)
python = runtime / 'Scripts' / 'python.exe'
lock = Path(__file__).parent / 'requirements.txt'
packages = ['-r', str(lock)] if lock.exists() else ['openwakeword==0.6.0']
subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', *packages], check=True)
models = target / 'models'
models.mkdir(exist_ok=True)
manifest = []
pinned_file = Path(__file__).parent / 'model-manifest.json'
pinned = {m['name']: m['sha256'] for m in json.loads(pinned_file.read_text(encoding='utf-8'))} if pinned_file.exists() else {}
for filename in ['hey_jarvis_v0.1.onnx', 'melspectrogram.onnx', 'embedding_model.onnx']:
    url = 'https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/' + filename
    destination = models / filename
    if not destination.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(30_000_001)
        if len(data) > 30_000_000:
            raise RuntimeError('Model exceeded size bound')
        destination.write_bytes(data)
    data = destination.read_bytes()
    if filename in pinned and hashlib.sha256(data).hexdigest() != pinned[filename]:
        raise RuntimeError('Model checksum mismatch: ' + filename)
    manifest.append({'name': filename, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'source': url})
(target / 'model-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
frozen = subprocess.check_output([str(python), '-m', 'pip', 'freeze'], text=True)
(target / 'installed-requirements.txt').write_text(frozen, encoding='utf-8')
print('Local wake runtime installed. Restart Jarvis. Real wake-word and speaker tests remain unverified.')
