/**
 * Which set of install directions a browser needs.
 *
 * Kept apart from `install.ts` for the same reason the domain layer is kept apart
 * from Dexie: this is the part with branches worth testing, and every one of those
 * branches is a browser that is, by definition, not the one anybody is testing in.
 * A pure function of what the browser says about itself can be checked against
 * real user-agent strings from a script; the same logic sitting next to a
 * `window.addEventListener` cannot be checked at all without a browser to run it
 * in — and then only the one.
 *
 * `beforeinstallprompt` is Chromium-only and not on a standards track, so the
 * install button is the exception rather than the rule. What everyone else does
 * is not one fallback but several.
 */

export type InstallHow =
  /**
   * A menu item exists. Chromium anywhere, and Safari on macOS 14+, which
   * installs from File → Add to Dock.
   */
  | 'menu'
  /**
   * iOS, where the Share menu is the only route. Since 16.4 it works in Safari,
   * Chrome, Edge and Firefox alike — they are all Safari underneath.
   */
  | 'ios'
  /** Firefox on Android: a home-screen shortcut, not an entry in the app list. */
  | 'firefox'
  /** Firefox on a computer, which cannot install web apps at all. */
  | 'none';

/** A browser, reduced to the three things this decision needs. */
export interface BrowserFacts {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
}

export function installRouteFor(facts: BrowserFacts): InstallHow {
  // iOS first, and the order is load-bearing: every browser there is Safari
  // underneath, so Firefox on an iPhone installs the iOS way and not the Firefox
  // way. Testing for Firefox first would send an iPhone user hunting for a menu
  // item that does not exist on their device.
  if (isIOSLike(facts)) return 'ios';

  if (/firefox|fxios/i.test(facts.userAgent)) {
    return /android/i.test(facts.userAgent) ? 'firefox' : 'none';
  }

  // The directions that suit the most people, and which are wrong in the least
  // damaging way when we cannot tell: a menu item to go and look for, rather
  // than a claim that it cannot be done.
  return 'menu';
}

function isIOSLike({ userAgent, platform, maxTouchPoints }: BrowserFacts): boolean {
  if (/iphone|ipad|ipod/i.test(userAgent)) return true;
  // iPadOS 13+ reports itself as a Mac. The touch points are what give it away,
  // and they are the only thing separating an iPad from a desktop Mac here.
  return platform === 'MacIntel' && maxTouchPoints > 1;
}
