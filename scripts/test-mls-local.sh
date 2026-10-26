#!/usr/bin/env bash
# Requires pre-fetched Cargo dependencies; no account, network or production data.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ -x .cache/cargo/bin/cargo ]]; then
  export CARGO_HOME="$PWD/.cache/cargo"
  export RUSTUP_HOME="$PWD/.cache/rustup"
  cargo_bin="$CARGO_HOME/bin/cargo"
else
  cargo_bin="${CARGO:-cargo}"
fi
"$cargo_bin" test --locked --offline --manifest-path crypto/ghostel-mls/Cargo.toml
