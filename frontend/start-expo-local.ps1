$env:NODE_OPTIONS = "--use-system-ca"
$env:EXPO_NO_TELEMETRY = "1"

npx.cmd expo start --web --port 19006 *> "$PSScriptRoot\expo-web.log"
