import { useState } from 'react';

import { promptInstall, type InstallOutcome } from '../pwa/install';
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
 * Where there is no prompt to fire — Safari, which has never had one — the
 * directions are not a consolation prize. They are the only route, so they are
 * written as instructions rather than as an apology.
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
              {state.how === 'ios'
                ? 'Safari installs apps from its share menu rather than from a button on the page, so this one has to be done by hand. It takes two taps.'
                : 'Your browser has not offered an install prompt on this page. It is usually still possible from the menu.'}
            </p>
          )}

          <h3 className="section-title">
            {state.kind === 'ready' ? 'Or do it by hand' : 'How to install it'}
          </h3>
          {state.kind === 'manual' && state.how === 'ios' ? <IosSteps /> : <MenuSteps />}
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

/** Safari, which has no prompt and never has had one. */
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
        It has to be Safari. Chrome on an iPhone cannot add apps to the home
        screen — Apple does not let it.
      </p>
    </>
  );
}
