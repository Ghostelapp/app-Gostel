#!/usr/bin/env python3
"""Fail closed on unreviewed SPDX expressions; inventory the locked Cargo graph.
Run with CARGO pointing to cargo, and task-local CARGO_HOME/RUSTUP_HOME if needed.
The inventory includes target-specific/build dependencies (a release superset).
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
metadata = json.loads(subprocess.check_output([
    os.environ.get("CARGO", "cargo"), "metadata", "--locked", "--offline",
    "--format-version", "1", "--manifest-path", str(root / "Cargo.toml"),
]))
choices = {
    "MIT": "MIT", "Apache-2.0": "Apache-2.0", "BSD-3-Clause": "BSD-3-Clause",
    "ISC": "ISC", "MPL-2.0": "MPL-2.0",
    "MIT OR Apache-2.0": "MIT", "Apache-2.0 OR MIT": "MIT",
    "Apache-2.0/MIT": "MIT", "MIT/Apache-2.0": "MIT",
    "Unlicense OR MIT": "MIT", "MIT OR Apache-2.0 OR BSD-1-Clause": "MIT",
    "MIT OR Apache-2.0 OR LGPL-2.1-or-later": "MIT",
    "(MIT OR Apache-2.0) AND Unicode-3.0": "MIT AND Unicode-3.0",
    "Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT": "MIT",
    "BSD-2-Clause OR Apache-2.0 OR MIT": "MIT",
}
rows = []
notice_texts = {}
notices = ["# Third-party notices — locked MLS dependency inventory\n",
           "Includes build and target-specific dependencies. Keep applicable notices in distributed binaries. "
           "MPL source links below provide the exact unmodified upstream packages; any future changes to MPL files must also be made available.\n"]
for p in sorted(metadata["packages"], key=lambda p: (p["name"], p["version"])):
    if p["name"] == "ghostel-mls" and p["source"] is None:
        continue
    expression = p.get("license")
    if expression not in choices:
        raise SystemExit("Unreviewed license: %s %s: %r" % (p["name"], p["version"], expression))
    source = "https://static.crates.io/crates/{0}/{0}-{1}.crate".format(p["name"], p["version"])
    row = {"name": p["name"], "version": p["version"], "declared_license": expression,
           "selected_license": choices[expression], "source": source, "notice_files": []}
    folder = Path(p["manifest_path"]).parent
    license_files = sorted({f for pattern in ("LICENSE*", "LICENCE*", "COPYING*", "NOTICE*") for f in folder.glob(pattern) if f.is_file()})
    notices.append("\n## {name} {version}\n\nLicense: {selected_license}. [Source]({source}).\n".format(**row))
    for file in license_files:
        raw = file.read_bytes()
        row["notice_files"].append({"name": file.name, "sha256": hashlib.sha256(raw).hexdigest()})
        digest = hashlib.sha256(raw).hexdigest()
        notice_texts[digest] = raw.decode("utf-8")
        notices.append("- [%s](#notice-%s)" % (file.name, digest))
    if not license_files:
        notices.append("\nSee the source package for copyright and license notices.\n")
    rows.append(row)
(root / "license-inventory.json").write_text(json.dumps(rows, indent=2) + "\n")
for digest, body in notice_texts.items():
    notices.append("\n## Notice " + digest + "\n\n```text\n" + body + "\n```\n")
(root / "THIRD_PARTY_NOTICES.md").write_text("\n".join(notices))
print("License inventory: %d locked third-party packages; no GPL/AGPL selected." % len(rows))
