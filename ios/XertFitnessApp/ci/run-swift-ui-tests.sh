#!/usr/bin/env bash

# Runs the My Coaching XCUITests on the same simulator the unit tests use.
# The app is launched with -XertRosterFixtures (DEBUG only): in-memory roster
# fixtures, no keychain session and no network, so nothing here can reach
# Supabase, Vercel or APNs. Screenshots are exported from the result bundle.

set -euo pipefail

: "${XCODE_PROJECT:?XCODE_PROJECT is required}"
: "${XCODE_SCHEME:?XCODE_SCHEME is required}"

RESULT_BUNDLE="build/ui-test-results.xcresult"
SCREENSHOT_DIR="build/ui-test-screenshots"

SIMULATOR_ID="$(xcrun simctl list devices available | awk -F '[()]' '/iPhone/ { print $2; exit }')"
if [[ -z "$SIMULATOR_ID" ]]; then
  echo "::error:: No available iPhone simulator was found."
  exit 1
fi

echo "Using iPhone simulator $SIMULATOR_ID for UI tests"
xcrun simctl boot "$SIMULATOR_ID" 2>/dev/null || true
xcrun simctl bootstatus "$SIMULATOR_ID" -b || echo "::warning:: Simulator boot status unavailable; letting xcodebuild wait for it."

rm -rf "$RESULT_BUNDLE" "$SCREENSHOT_DIR"

if xcodebuild test \
  -project "$XCODE_PROJECT" \
  -scheme "$XCODE_SCHEME" \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=$SIMULATOR_ID" \
  -destination-timeout 300 \
  -only-testing:XertFitnessUITests \
  -parallel-testing-enabled NO \
  -test-timeouts-enabled YES \
  -default-test-execution-time-allowance 180 \
  -maximum-test-execution-time-allowance 300 \
  -resultBundlePath "$RESULT_BUNDLE" \
  CODE_SIGNING_ALLOWED=NO; then
  TEST_STATUS=0
else
  TEST_STATUS=$?
fi

# Evidence only: an export problem never replaces xcodebuild's result.
if mkdir -p "$SCREENSHOT_DIR" \
  && xcrun xcresulttool export attachments --path "$RESULT_BUNDLE" --output-path "$SCREENSHOT_DIR"; then
  COUNT="$(find "$SCREENSHOT_DIR" -type f -iname '*.png' | wc -l | tr -d ' ')"
  echo "Exported ${COUNT} UI test screenshots."
else
  echo "::warning:: Could not export UI test screenshots; the .xcresult bundle still holds them."
fi

if [[ "$TEST_STATUS" -ne 0 ]]; then
  echo "::error:: My Coaching UI tests failed (exit ${TEST_STATUS})."
fi
exit "$TEST_STATUS"
