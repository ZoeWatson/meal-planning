import { useState } from 'react';

import { promptInstall, type InstallOutcome } from '../pwa/install';
import type { InstallHow } from '../pwa/installRoute';
import { useInstallState } from '../pwa/useInstallState';
import { CheckIcon } from '../components/icons';

/**
 * One button, and an honest account of what it does.
 *
 * This tab exists because the browser's own install route is a menu item most
 * people never find, and the app is meant to be sendable to someone who will not
 * go looking. It disappears once the app is installed — a tab that says "you have
 * already done this" is a permanent tax on a one-time action, and the tab bar was
 * built for six.
 *
 * The button is the exception, not the rule: `beforeinstallprompt` is Chromium's
 * alone. Everywhere else the directions are not a consolation prize but the only
 * route, so they are written as instructions rather than as an apology — and they
 * differ per browser, because one set of steps would be wrong for most of them.
 * Firefox on a computer gets the hardest version of that: it cannot install web
 * apps at all, and saying so plainly beats sending somebody to hunt through a
 * menu for an item Mozilla removed.
 */
export function InstallScreen(): JSX.Element {
  const state = useInstallState();
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  async function install(): Promise<void> {
    setBusy(true);
    try {
      setOutcome(await promptInstall());
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen">
      <div className="header">
        <h1>Install</h1>
        <div className="sub">Put this on your home screen and it stops being a website.</div>
      </div>

      {state.kind === 'installed' ? (
        <div className="card" style={{ borderColor: 'var(--accent)', marginTop: 14 }}>
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <span style={{ color: 'var(--accent)', display: 'flex' }}><CheckIcon /></span>
            <div>
              <div className="strong" style={{ color: 'var(--accent)' }}>Installed</div>
              <div className="small dim">
                You are using the installed app. This tab disappears as soon as you
                leave it — there is nothing left to do here.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginTop: 14 }}>
            <WhatYouGet />
          </div>

          {state.kind === 'ready' ? (
            <>
              <button
                className="btn primary block"
                style={{ marginTop: 16, height: 56, fontSize: 17 }}
                disabled={busy}
                onClick={() => void install()}
              >
                {busy ? 'Installing…' : 'Install'}
              </button>

              {outcome === 'dismissed' && (
                <p className="tiny faint" style={{ marginTop: 8, textAlign: 'center' }}>
                  Not this time, then. The directions below still work whenever you
                  change your mind.
                </p>
              )}
              {outcome === 'unavailable' && (
                <p className="tiny faint" style={{ marginTop: 8, textAlign: 'center' }}>
                  Your browser did not offer a prompt. Use the directions below.
                </p>
              )}
            </>
          ) : (
            <p className="tiny faint" style={{ marginTop: 14 }}>
              {EXPLANATION[state.how]}
            </p>
          )}

          <h3 className="section-title">
            {state.kind === 'ready' ? 'Or do it by hand'
              : state.how === 'none' ? 'What you can do instead'
              : 'How to install it'}
          </h3>
          {state.kind === 'manual' ? <Steps how={state.how} /> : <MenuSteps />}
        </>
      )}

      <h3 className="section-title">Where your data lives</h3>
      <p className="tiny faint" style={{ margin: '-4px 0 0' }}>
        On this device, and nowhere else. There is no account and no server: your
        plans, shopping lists and prices never leave the phone or computer you
        typed them into. That is also the catch — nothing else has a copy, so if
        this is the only place your week exists, use{' '}
        <strong>More → Move data between devices</strong> now and then to get a
        file out.
      </p>
    </main>
  );
}

function WhatYouGet(): JSX.Element {
  return (
    <>
      <Point>Its own icon on your home screen, opening straight into the app.</Point>
      <Point>
        No address bar, no browser tabs — it fills the screen like any other app.
      </Point>
      <Point>
        Works with no signal. The whole thing is on the device, so a shopping list
        in a supermarket basement behaves exactly as it does at home.
      </Point>
      <Point last>
        Your data is kept more safely. Browsers clear storage for ordinary websites
        when space runs short; an installed app is left alone.
      </Point>
    </>
  );
}

function Point({ children, last }: { children: React.ReactNode; last?: boolean }): JSX.Element {
  return (
    <div className="row" style={{ gap: 8, marginBottom: last ? 0 : 10, alignItems: 'flex-start' }}>
      <span style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 1, display: 'flex' }}>
        <CheckIcon size={16} />
      </span>
      <span className="small">{children}</span>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }): JSX.Element {
  return (
    <div className="card tight row" style={{ gap: 10, alignItems: 'flex-start' }}>
      <span
        className="tiny strong"
        style={{
          flexShrink: 0, width: 20, height: 20, borderRadius: 10,
          background: 'var(--accent)', color: 'var(--surface)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        {n}
      </span>
      <span className="small">{children}</span>
    </div>
  );
}

const EXPLANATION: Readonly<Record<InstallHow, string>> = {
  menu: 'Your browser has not offered an install prompt on this page. It is usually still possible from the menu.',
  ios: 'On an iPhone or iPad, apps are added from the share menu rather than from a button on the page. It takes three taps.',
  firefox: 'Firefox does not let a page offer an install button, but it can put this on your home screen from its own menu.',
  none: 'Firefox on a computer cannot install web apps — Mozilla removed the feature and has not brought it back. Nothing is wrong with your browser or with this page.',
};

function Steps({ how }: { how: InstallHow }): JSX.Element {
  if (how === 'ios') return <IosSteps />;
  if (how === 'firefox') return <FirefoxSteps />;
  if (how === 'none') return <NoInstallSteps />;
  return <MenuSteps />;
}

/** Chrome and Edge, on a phone or a computer. */
function MenuSteps(): JSX.Element {
  return (
    <>
      <Step n={1}>
        Open the browser menu — <strong>⋮</strong> on a phone, <strong>⋮</strong> or{' '}
        <strong>⋯</strong> at the top right on a computer.
      </Step>
      <Step n={2}>
        Choose <strong>Install app</strong>. Some versions call it{' '}
        <strong>Add to Home screen</strong>, and Edge keeps it under{' '}
        <strong>Apps</strong>.
      </Step>
      <Step n={3}>Confirm, and the icon appears with your other apps.</Step>
      <p className="tiny faint" style={{ marginTop: 8 }}>
        On a computer there is often an install icon at the right-hand end of the
        address bar as well, which does the same thing in one click.
      </p>
    </>
  );
}

/** iOS, where the share menu is the only route and always has been. */
function IosSteps(): JSX.Element {
  return (
    <>
      <Step n={1}>
        Tap the <strong>Share</strong> button — the square with an arrow coming out
        of it, at the bottom of the screen.
      </Step>
      <Step n={2}>
        Scroll down the list and tap <strong>Add to Home Screen</strong>.
      </Step>
      <Step n={3}>
        Tap <strong>Add</strong>, top right.
      </Step>
      <p className="tiny faint" style={{ marginTop: 8 }}>
        Safari, Chrome, Edge and Firefox all work for this on iOS 16.4 and later.
        On anything older it has to be Safari.
      </p>
    </>
  );
}

/** Firefox on Android: a shortcut rather than an app entry, but it works. */
function FirefoxSteps(): JSX.Element {
  return (
    <>
      <Step n={1}>Tap the <strong>⋮</strong> menu, top right.</Step>
      <Step n={2}>
        Tap <strong>Add to Home screen</strong>, then confirm.
      </Step>
      <p className="tiny faint" style={{ marginTop: 8 }}>
        Firefox adds a shortcut with a small Firefox badge on it, which opens the
        app inside Firefox rather than as a separate entry in your app list. It
        still works offline and your data is still kept on the device. Chrome and
        Samsung Internet are the two that install it as a proper app.
      </p>
    </>
  );
}

/** Firefox on a computer, which has no install route at all. */
function NoInstallSteps(): JSX.Element {
  return (
    <>
      <Step n={1}>
        Use it in this tab. Everything works — the planner, the shopping list, and
        your data saved on this computer — and it works with no connection once the
        page has loaded once. Bookmark it and it is a click away.
      </Step>
      <Step n={2}>
        If you want it as a real window with its own icon, open this page in
        <strong> Chrome</strong> or <strong>Edge</strong> and install it from there.
        It is the same app and the same address.
      </Step>
      <p className="tiny faint" style={{ marginTop: 8 }}>
        Your data belongs to the browser that stored it, so a week planned here
        will not appear in Chrome. <strong>More → Move data between devices</strong>{' '}
        carries it across if you switch.
      </p>
    </>
  );
}
