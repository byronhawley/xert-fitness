import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (relative) => readFile(new URL(relative, root), 'utf8');
const appDir = fileURLToPath(new URL('ios/XertFitnessApp/XertFitnessApp/', root));

async function swiftFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return swiftFiles(full);
    return entry.name.endsWith('.swift') ? [full] : [];
  }));
  return nested.flat();
}

/** Lines of Swift source outside every `#if DEBUG` branch. */
function linesOutsideDebug(source) {
  const stack = [];
  const outside = [];
  for (const line of source.split('\n')) {
    const directive = line.trim();
    if (directive.startsWith('#if')) {
      stack.push(/^#if\s+DEBUG\b/.test(directive) ? 'debug' : 'other');
      continue;
    }
    if (directive.startsWith('#else') || directive.startsWith('#elseif')) {
      if (stack.at(-1) === 'debug') stack[stack.length - 1] = 'not-debug';
      continue;
    }
    if (directive.startsWith('#endif')) {
      stack.pop();
      continue;
    }
    if (!stack.includes('debug')) outside.push(line);
  }
  return outside;
}

test('manager roster notices open only the allowlisted web console path', async () => {
  const links = await read('ios/XertFitnessApp/XertFitnessApp/StaffRoster/StaffRosterLinks.swift');
  const workspace = await read('src/components/admin/staffRoster/StaffRosterWorkspace.jsx');
  const aasa = await read('public/.well-known/apple-app-site-association');

  const webTabs = [...workspace.match(/const TABS = \[([\s\S]*?)\];/)[1].matchAll(/value: '([a-z]+)'/g)].map(m => m[1]);
  const nativeTabs = [...links.match(/static let allowedTabs: \[String\] = \[([^\]]*)\]/)[1].matchAll(/"([a-z]+)"/g)].map(m => m[1]);
  assert.deepEqual(nativeTabs, webTabs, 'native console tabs mirror the web workspace tabs');

  assert.match(links, /static let path = "\/admin\/roster"/);
  assert.match(links, /static let audienceKey = "audience"/);
  assert.match(links, /components\.scheme = "https"\s*\n\s*components\.host = AppConfig\.vercelHost/);
  assert.match(links, /item\.name == "rosterTab"/);
  assert.match(links, /item\.name == "rosterMonth"/);
  assert.doesNotMatch(links, /"rosterFocus"/, 'record ids are never carried into the console URL');
  assert.match(links, /components\.scheme == nil,\s*\n\s*components\.host == nil/);

  // The console path is not app-claimed, so opening it never loops back into the app.
  assert.doesNotMatch(aasa, /\/admin/);
});

test('manager pushes open the console; coach pushes keep My Coaching and sign-in continuation', async () => {
  const root = await read('ios/XertFitnessApp/XertFitnessApp/Views/RootView.swift');
  const coaching = await read('ios/XertFitnessApp/XertFitnessApp/Views/MyCoachingView.swift');
  const consumer = root.slice(root.indexOf('private func consumePendingStaffRosterRoute'));
  const body = consumer.slice(0, consumer.indexOf('\n    }\n'));

  assert.match(body, /case \.coaching\(let link\):[\s\S]*openMemberRoute\(\.coaching\(link\), source: \.pushNotification\)/);
  assert.match(body, /case \.managerConsole\(let link\):\s*\n\s*StaffRosterManagerConsole\.open\(link, using: openURL\)/);
  const managerBranch = body.slice(body.indexOf('case .managerConsole'));
  assert.doesNotMatch(managerBranch, /openMemberRoute|noteOpenedFromNotification/);
  assert.match(coaching, /else if let managerLink = item\.managerLink \{[\s\S]*StaffRosterManagerConsole\.open\(managerLink, using: openURL\)/);
});

test('a My Coaching link resumed after sign-in or a cold launch still presents My Coaching', async () => {
  const root = await read('ios/XertFitnessApp/XertFitnessApp/Views/RootView.swift');
  const account = await read('ios/XertFitnessApp/XertFitnessApp/Views/AccountView.swift');
  const coaching = await read('ios/XertFitnessApp/XertFitnessApp/Views/MyCoachingView.swift');

  const resume = root.slice(root.indexOf('private func resumePendingProtectedNavigation'));
  const resumeBody = resume.slice(0, resume.indexOf('\n    }\n'));
  assert.match(resumeBody, /navigation\.open\(intent\.route, source: intent\.source\)\s*\n\s*if case \.coaching\(let link\) = intent\.route \{[\s\S]*staffRoster\.open\(link\)/);

  const present = account.slice(account.indexOf('private func presentRequestedCoaching'));
  const presentBody = present.slice(0, present.indexOf('\n    }\n'));
  assert.match(presentBody, /presentCoaching\(attempt: 0\)/);
  assert.doesNotMatch(presentBody, /showingCoaching = true/, 'never pushed in the same update that asked for it');
  const retry = account.slice(account.indexOf('private func presentCoaching(attempt: Int)'));
  assert.match(retry, /await Task\.yield\(\)[\s\S]*showingCoaching = true[\s\S]*!coachingDestinationVisible[\s\S]*coachingAppearances == appearances[\s\S]*presentCoaching\(attempt: attempt \+ 1\)/);
  assert.match(account, /MyCoachingView\(staffRoster: staffRoster\)\s*\n\s*\.onAppear \{\s*\n\s*coachingDestinationVisible = true\s*\n\s*coachingAppearances &\+= 1/);

  // The greeting is styled upper case, so UI tests find it by identifier.
  assert.match(coaching, /Text\("Hi \\\(me\.staff\.display_name\)"\)[\s\S]{0,160}\.accessibilityIdentifier\("coaching-greeting"\)/);
});

test('UI-test fixtures compile only into DEBUG builds and block the network', async () => {
  const fixtures = await read('ios/XertFitnessApp/XertFitnessApp/StaffRoster/StaffRosterFixtures.swift');
  assert.match(fixtures, /^#if DEBUG\n/);
  assert.match(fixtures, /\n#endif\n?$/);
  assert.equal(linesOutsideDebug(fixtures).filter(line => line.trim()).length, 0);

  const fixtureSymbols = /XertUITestFixtures|StaffRosterFixtureService|XertUITestHooks|XertUITestHookOverlay/;
  for (const file of await swiftFiles(appDir)) {
    const source = await readFile(file, 'utf8');
    const leaks = linesOutsideDebug(source).filter(line => fixtureSymbols.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('///'));
    assert.deepEqual(leaks, [], `${path.basename(file)} uses fixture code outside #if DEBUG`);
  }

  const api = await read('ios/XertFitnessApp/XertFitnessApp/Services/XertAPI.swift');
  const validated = api.slice(api.indexOf('private func validatedResponse'));
  assert.ok(validated.indexOf('XertUITestFixtures.isActive') < validated.indexOf('session.data(for: request)'));
  const store = await read('ios/XertFitnessApp/XertFitnessApp/Store/XertStore.swift');
  const bootstrap = store.slice(store.indexOf('private func performBootstrap'));
  assert.ok(bootstrap.indexOf('XertUITestFixtures.isActive') < bootstrap.indexOf('KeychainStore.loadSession()'));
  assert.match(fixtures, /static let launchArgument = "-XertRosterFixtures"/);
});

test('XCUITests run on the CI simulator and keep screenshots', async () => {
  const project = await read('ios/XertFitnessApp/project.yml');
  const workflow = await read('.github/workflows/quality.yml');
  const runner = await read('ios/XertFitnessApp/ci/run-swift-ui-tests.sh');
  const unitRunner = await read('ios/XertFitnessApp/ci/run-swift-tests.sh');
  const uiTests = await read('ios/XertFitnessApp/XertFitnessUITests/MyCoachingUITests.swift');

  assert.match(project, /XertFitnessUITests:\s*\n\s*type: bundle\.ui-testing/);
  assert.match(project, /TEST_TARGET_NAME: XertFitness/);
  assert.match(project, /scheme:\s*\n\s*testTargets:\s*\n\s*- XertFitnessTests\s*\n\s*- XertFitnessUITests/);
  assert.match(unitRunner, /-only-testing:XertFitnessTests/, 'unit runs stay unit-only');

  assert.match(runner, /-only-testing:XertFitnessUITests/);
  assert.match(runner, /awk -F '\[\(\)\]' '\/iPhone\/ \{ print \$2; exit \}'/, 'same simulator choice as the unit tests');
  assert.match(runner, /xcresulttool export attachments/);
  assert.match(workflow, /bash ci\/run-swift-ui-tests\.sh/);
  assert.match(workflow, /ui-test-results\.xcresult/);

  assert.match(uiTests, /"-XertRosterFixtures"/);
  assert.match(uiTests, /attachment\.lifetime = \.keepAlways/);
  assert.doesNotMatch(uiTests, /staticTexts\["Hi Sam Fixture"\]/, 'the greeting label is upper case on device');
  assert.match(uiTests, /app\.staticTexts\["coaching-greeting"\]/);
  assert.match(uiTests, /greeting\.label\.lowercased\(\),\s*\n\s*"hi sam fixture"/);
  assert.doesNotMatch(uiTests, /URLSession|supabase\.co|apikey/i);
  for (const name of [
    'testCoachWalksUpcomingAndMyRosterAcrossTheMonthBoundary',
    'testAvailabilityEditSaveReviewAndSubmit',
    'testAvailabilitySaveFailureShowsRetry',
    'testAvailabilityStaleVersionConflict',
    'testAbsenceAndCoverVolunteering',
    'testFeatureOffHidesMyCoaching',
    'testSignedOutLinkContinuesToMyCoachingAfterSignIn',
    'testCoachPushOpensMyCoaching',
    'testManagerPushOpensTheWebConsoleNotMyCoaching',
    'testSignedOutManagerPushNeedsNoAppSignIn',
    'testRevokedCoachSeesNotAvailable',
    'testInAppManagerNoticeOpensTheWebConsole',
  ]) {
    assert.match(uiTests, new RegExp(`func ${name}\\(`));
  }

  const unit = await read('ios/XertFitnessApp/XertFitnessAppTests/StaffRosterTests.swift');
  for (const name of [
    'testCoachPersonalNoticeOpensMyCoaching',
    'testManagerRequestOpensTheWebConsoleNotMyCoaching',
    'testAdminWhoAlsoCoachesGetsTheDestinationOfEachNotice',
    'testSignedOutDestinationSurvivesSignInAndColdLaunch',
    'testRevokedRecipientIsDecidedByTheServerNotTheLink',
    'testManagerConsoleLinksAreStrictlyAllowlisted',
  ]) {
    assert.match(unit, new RegExp(`func ${name}\\(`));
  }
});
