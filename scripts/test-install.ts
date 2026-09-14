/**
 * Install-route tests.
 *
 * Every branch of `installRouteFor` is a browser that is, by definition, not the
 * one anybody is testing in — so "it looked right when I opened it" checks
 * exactly one case and silently guesses at the rest. These are real user-agent
 * strings, which is the only thing that gives the branches any weight.
 *
 * What is at stake is not cosmetic. Telling a Firefox-on-desktop user to find
 * "Install app" in a menu sends them hunting for something Mozilla removed, and
 * they conclude the app is broken rather than that the instructions are wrong.
 *
 * Run with: npm run test:install
 */

import assert from 'node:assert/strict';

import { installRouteFor, type InstallHow } from '../src/pwa/installRoute';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.log(`\x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

function group(name: string): void {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function route(
  userAgent: string,
  { platform = 'Linux x86_64', maxTouchPoints = 0 } = {},
): InstallHow {
  return installRouteFor({ userAgent, platform, maxTouchPoints });
}

const UA = {
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  chromeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  edgeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  samsung: 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0',
  firefoxWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  safariIPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  chromeIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/125.0 Mobile/15E148 Safari/605.1.15',
};

// ---------------------------------------------------------------------------

group('Chromium and Safari get the menu');

test('Chrome on Android', () => assert.equal(route(UA.chromeAndroid), 'menu'));
test('Chrome on a computer', () => assert.equal(route(UA.chromeDesktop), 'menu'));
test('Edge', () => assert.equal(route(UA.edgeDesktop), 'menu'));
test('Samsung Internet', () => assert.equal(route(UA.samsung), 'menu'));
test('Safari on a Mac — File → Add to Dock', () => {
  assert.equal(route(UA.safariMac, { platform: 'MacIntel' }), 'menu');
});

group('Firefox');

test('on Android, its own home-screen shortcut', () => {
  assert.equal(route(UA.firefoxAndroid), 'firefox');
});

test('on Windows, no install route at all', () => {
  assert.equal(route(UA.firefoxWindows, { platform: 'Win32' }), 'none');
});

test('on Linux, likewise', () => assert.equal(route(UA.firefoxLinux), 'none'));

test('on a Mac, likewise — and not mistaken for an iPad', () => {
  // A desktop Mac reports MacIntel with no touch points. Only the touch points
  // separate it from an iPad, so this is the case that breaks if that check is
  // ever loosened to platform alone.
  assert.equal(route(UA.firefoxMac, { platform: 'MacIntel', maxTouchPoints: 0 }), 'none');
});

group('iOS: every browser is Safari underneath');

test('Safari on an iPhone', () => assert.equal(route(UA.safariIPhone), 'ios'));

test('Chrome on an iPhone is iOS, not Chromium', () => {
  // It cannot fire an install prompt however Chromium it looks, because it is
  // not Chromium. Since 16.4 it can still add to the home screen from Share.
  assert.equal(route(UA.chromeIOS), 'ios');
});

test('Firefox on an iPhone is iOS, not Firefox', () => {
  // The branch order is what makes this true, and getting it backwards would
  // send an iPhone user looking for a Firefox menu item that is not there.
  assert.equal(route(UA.firefoxIOS), 'ios');
});

test('an iPad pretending to be a Mac is still iOS', () => {
  assert.equal(
    route('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      { platform: 'MacIntel', maxTouchPoints: 5 }),
    'ios',
  );
});

group('Nothing to go on');

test('an empty user agent falls back to the menu', () => {
  // The directions that are right for the most people, and wrong in the least
  // damaging way: a menu item to look for rather than a claim of impossibility.
  assert.equal(route(''), 'menu');
});

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed === 0 ? 0 : 1);
