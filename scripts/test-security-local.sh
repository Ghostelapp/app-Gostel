#!/usr/bin/env bash
# Offline regression suite. Does not load .env or access production services.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 scripts/check-mls-runtime.py
python3 -m unittest \
  backend.tests.test_security_audit_unit \
  backend.tests.test_ws_security_unit \
  backend.tests.test_request_limits_unit \
  backend.tests.test_push_privacy_unit \
  backend.tests.test_call_transitions_unit
node --test tests/security-audit.cjs tests/mls-vault.cjs tests/mls-native-vault.cjs tests/staging-config.cjs frontend/tests/calls.test.cjs
./frontend/node_modules/.bin/tsc --noEmit -p frontend/tsconfig.json
# AGPL evaluation tooling is opt-in and outside the closed-source product.
if [[ "${GHOSTEL_TEST_AGPL_PROTOTYPE:-0}" == "1" ]]; then
  npm test --prefix tools/signal-prototype
fi
./scripts/test-mls-local.sh
node --check server.js
node --check frontend/desktop/main.cjs
node --check frontend/desktop/preload.cjs
node --check frontend/desktop/mls-vault.cjs
git diff --check
