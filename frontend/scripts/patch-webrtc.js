/**
 * Patches react-native-webrtc to fix the broken `event-target-shim/index`
 * import path which no longer exists in event-target-shim v6.0.2 (only
 * `event-target-shim` root is exposed in its package.json `exports`).
 *
 * Patches BOTH compiled output (`lib/`) AND source files (`src/`) because
 * Metro / Expo Export uses the TypeScript source files directly when the
 * package.json declares a `source` field (which react-native-webrtc does).
 *
 * Idempotent — safe to re-run.
 */
const fs = require('fs');
const path = require('path');

const ROOTS = [
  path.join(__dirname, '..', 'node_modules', 'react-native-webrtc', 'lib'),
  path.join(__dirname, '..', 'node_modules', 'react-native-webrtc', 'src'),
];

const TARGET_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (TARGET_EXTS.has(path.extname(name))) {
      files.push(full);
    }
  }
  return files;
}

let patched = 0;
for (const root of ROOTS) {
  for (const f of walk(root)) {
    const src = fs.readFileSync(f, 'utf8');
    if (src.includes('event-target-shim/index')) {
      fs.writeFileSync(
        f,
        src.replace(/event-target-shim\/index/g, 'event-target-shim'),
      );
      patched += 1;
    }
  }
}
if (patched > 0) {
  console.log(
    `[patch-webrtc] Fixed ${patched} files (event-target-shim/index -> event-target-shim)`,
  );
} else {
  console.log('[patch-webrtc] Nothing to patch (already clean)');
}
