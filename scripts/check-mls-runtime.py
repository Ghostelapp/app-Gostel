#!/usr/bin/env python3
"""Reject a stale checked-in runtime before tests/release."""
import base64
import hashlib
import json
import re
from pathlib import Path
root = Path(__file__).resolve().parent.parent
source = hashlib.sha256()
for name in ('Cargo.toml', 'Cargo.lock', 'src/lib.rs', 'src/bridge.rs'):
    source.update((root / 'crypto/ghostel-mls' / name).read_bytes())
text = (root / 'frontend/src/mls/runtime.generated.ts').read_text()
assert text.startswith('// Source SHA-256: ' + source.hexdigest() + '\n'), 'Stale MLS runtime: run scripts/build-mls-runtime.sh'
script = json.loads(text.split('export const MLS_RUNTIME_SCRIPT: string = ', 1)[1].rstrip().removesuffix(';'))
encoded = re.search(r'Uint8Array.from\(atob\(("[A-Za-z0-9+/=]+")\)', script)
assert encoded, 'Missing bundled WASM'
wasm = base64.b64decode(json.loads(encoded[1]), validate=True)
assert '// WASM SHA-256: ' + hashlib.sha256(wasm).hexdigest() + '\n' in text, 'WASM checksum mismatch'
print('MLS runtime source and WASM checksums match')
