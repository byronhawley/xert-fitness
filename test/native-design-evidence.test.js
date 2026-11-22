import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const runner = fileURLToPath(new URL('../ios/XertFitnessApp/ci/run-swift-tests.sh', import.meta.url));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';

test('attachment export never masks the original xcodebuild result and is opt-in', { skip: !existsSync(bash) }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'xert-native-evidence-'));
  try {
    await mkdir(path.join(root, 'bin'));
    const stub = async (name, contents) => writeFile(path.join(root, 'bin', name), `#!/usr/bin/env bash\n${contents}\n`, { mode: 0o755 });
    await stub('xcodebuild', 'mkdir -p build/test-results.xcresult\nexit "$MOCK_TEST_STATUS"');
    await stub('sleep', 'command -p sleep 0.5');
    await stub('xcrun', `
if [[ "$1 $2 $3" == "simctl list devices" ]]; then
  printf 'iPhone Fixture (FAKE-SIMULATOR) (Shutdown)\\n'
elif [[ "$1" == "xcresulttool" ]]; then
  echo export >> export-calls.txt
  if [[ "$*" == *"--help"* ]]; then exit 0; fi
  if [[ "$MOCK_EXPORT_STATUS" != "0" ]]; then exit "$MOCK_EXPORT_STATUS"; fi
  touch build/test-attachments/fixture.png
fi
`);
    for (const [testStatus, exportStatus, enabled] of [[0, 0, true], [0, 9, true], [65, 9, true], [65, 0, false]]) {
      await rm(path.join(root, 'build'), { recursive: true, force: true });
      await rm(path.join(root, 'export-calls.txt'), { force: true });
      const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'export PATH="$PWD/bin:$PATH"; exec bash "$RUNNER"'], {
        cwd: root, encoding: 'utf8', timeout: 15000,
        env: { ...process.env, RUNNER: runner.replaceAll('\\', '/'), XCODE_PROJECT: 'Fixture.xcodeproj', XCODE_SCHEME: 'Fixture', EXPORT_TEST_ATTACHMENTS: String(enabled), MOCK_TEST_STATUS: String(testStatus), MOCK_EXPORT_STATUS: String(exportStatus) },
      });
      assert.equal(result.status, testStatus, result.stderr || result.stdout);
      if (enabled && exportStatus !== 0) assert.match(result.stdout, /No PNG XCTest attachments were exported/);
      if (!enabled) assert.equal(existsSync(path.join(root, 'export-calls.txt')), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('only the verify workflow exports images and native tests host real controls without services', async () => {
  const workflow = await readFile(new URL('../codemagic.yaml', import.meta.url), 'utf8');
  const [verify, release] = workflow.split('  ios-testflight:');
  assert.match(verify, /EXPORT_TEST_ATTACHMENTS: "true"/);
  assert.match(verify, /test-attachments\/\*\*\/\*\.png/);
  assert.match(verify, /test-attachments\/\*\*\/\*\.json/);
  assert.doesNotMatch(release, /EXPORT_TEST_ATTACHMENTS|test-attachments/);
  const tests = await readFile(new URL('../ios/XertFitnessApp/XertFitnessAppTests/NativeDesignSystemTests.swift', import.meta.url), 'utf8');
  assert.match(tests, /UIHostingController\(rootView: content\)/);
  assert.match(tests, /XCTAttachment\(image: image\)/);
  assert.match(tests, /attachment\.lifetime = \.keepAlways/);
  assert.match(tests, /size: \.accessibility3/);
  assert.match(tests, /axis: \.vertical, lineRange: 3\.\.\.8, externalFocus: \$editorFocused/);
  assert.doesNotMatch(tests, /Supabase|URLSession|launchArguments|auth.*bypass/i);
});
