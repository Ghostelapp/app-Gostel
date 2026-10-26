#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -x .cache/cargo/bin/cargo ]]; then
  export CARGO_HOME="$PWD/.cache/cargo" RUSTUP_HOME="$PWD/.cache/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi
export RUSTFLAGS='--cfg getrandom_backend="wasm_js"'
cargo build --locked --manifest-path crypto/ghostel-mls/Cargo.toml --target wasm32-unknown-unknown --release
mkdir -p .cache/mls-wasm
wasm-bindgen --target no-modules --out-dir .cache/mls-wasm crypto/ghostel-mls/target/wasm32-unknown-unknown/release/ghostel_mls.wasm
python3 scripts/package-mls-runtime.py
