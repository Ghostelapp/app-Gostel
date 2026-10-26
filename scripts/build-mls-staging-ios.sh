#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../frontend"
export EXPO_NO_DOTENV=1 APP_VARIANT=staging EXPO_PUBLIC_APP_VARIANT=staging EXPO_STAGING_NO_PUSH=1
export EXPO_PUBLIC_MLS_SELF_TEST=1
export METRO_CACHE_ROOT="$PWD/.metro-cache/staging"
export EXPO_USE_COMMUNITY_AUTOLINKING=1 EXPO_USE_JSC_IOS=1
export EXPO_PUBLIC_BACKEND_URL="${EXPO_PUBLIC_BACKEND_URL:-http://127.0.0.1:18794}"
# Do not overwrite an existing native project from another app variant.
if [[ -d ios && ! -d ios/GhostelStaging.xcodeproj ]]; then
  echo 'Move the existing generated frontend/ios project aside before building staging.' >&2
  exit 1
fi
node node_modules/expo/bin/cli prebuild --platform ios --no-install
cd ios
pod install
xcodebuild -jobs "${GHOSTEL_BUILD_JOBS:-4}" -workspace GhostelStaging.xcworkspace -scheme GhostelStaging \
  -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ../../.cache/mls-staging-ios CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- ONLY_ACTIVE_ARCH=YES ARCHS="$(uname -m)" build
