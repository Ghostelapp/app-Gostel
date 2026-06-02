/**
 * Expo config plugin that patches `react-native-webrtc` to fix the broken
 * `event-target-shim/index` import path.
 *
 * Why this exists
 * ---------------
 * - `react-native-webrtc` (v124.x) imports from `event-target-shim/index`,
 *   but `event-target-shim@6.x` removed the `./index` sub-path export.
 *   This causes Metro / Expo Export to fail with:
 *     "Missing './index' specifier in 'event-target-shim' package"
 *
 * - Patching `node_modules` from `postinstall` script does NOT work on
 *   Emergent's EAS build pipeline because the pipeline REPLACES the
 *   `postinstall` field in package.json with its own `apply-expo-patch.js`.
 *
 * - A Config Plugin, however, runs as part of `expo prebuild` which IS
 *   executed on EAS Build servers before the native compile, so the patch
 *   is guaranteed to be applied right before Metro runs.
 *
 * The plugin scans `node_modules/react-native-webrtc/{lib,src}` and rewrites
 * every occurrence of `event-target-shim/index` to `event-target-shim`.
 *
 * Idempotent — safe to re-run.
 */
const fs = require('fs');
const path = require('path');

const TARGET_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs']);
const SEARCH = /event-target-shim\/index/g;

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(full, files);
    } else if (TARGET_EXTS.has(path.extname(name))) {
      files.push(full);
    }
  }
  return files;
}

function applyPatch(projectRoot) {
  const webrtcRoot = path.join(
    projectRoot,
    'node_modules',
    'react-native-webrtc',
  );
  if (!fs.existsSync(webrtcRoot)) {
    console.warn(
      '[withWebRtcEventTargetShimFix] react-native-webrtc not found in node_modules — skipping',
    );
    return 0;
  }
  const dirs = [path.join(webrtcRoot, 'lib'), path.join(webrtcRoot, 'src')];
  let patched = 0;
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (SEARCH.test(content)) {
        const fixed = content.replace(SEARCH, 'event-target-shim');
        fs.writeFileSync(file, fixed);
        patched += 1;
      }
    }
  }
  if (patched > 0) {
    console.log(
      `[withWebRtcEventTargetShimFix] Patched ${patched} files (event-target-shim/index -> event-target-shim)`,
    );
  } else {
    console.log(
      '[withWebRtcEventTargetShimFix] Nothing to patch (already clean)',
    );
  }
  return patched;
}

/**
 * @param {import('@expo/config-types').ExpoConfig} config
 */
module.exports = function withWebRtcEventTargetShimFix(config) {
  try {
    applyPatch(process.cwd());
  } catch (e) {
    console.warn(
      '[withWebRtcEventTargetShimFix] Failed to apply patch:',
      e && e.message ? e.message : e,
    );
  }
  return config;
};
