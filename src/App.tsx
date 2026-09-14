import { useState } from 'react';

import { useAppState } from './state/useAppState';
import { PlanScreen } from './screens/PlanScreen';
import { GroceryScreen } from './screens/GroceryScreen';
import { BudgetScreen } from './screens/BudgetScreen';
import { RecipesScreen } from './screens/RecipesScreen';
import { CookScreen } from './screens/CookScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { InstallScreen } from './screens/InstallScreen';
import { useInstallState } from './pwa/useInstallState';
import {
  BookIcon, CalendarIcon, CartIcon, DownloadIcon, GearIcon, PotIcon, WalletIcon,
} from './components/icons';

type Tab = 'plan' | 'grocery' | 'cook' | 'budget' | 'recipes' | 'settings' | 'install';

// Six tabs is the practical ceiling on a 375px phone — roughly 62px each, which
// still clears a 44px touch target. Labels are kept to one short word for that
// reason.
const TABS: ReadonlyArray<{ id: Tab; label: string; Icon: (p: { size?: number }) => JSX.Element }> = [
  { id: 'plan', label: 'Week', Icon: CalendarIcon },
  { id: 'grocery', label: 'Shop', Icon: CartIcon },
  { id: 'cook', label: 'Cook', Icon: PotIcon },
  { id: 'budget', label: 'Spend', Icon: WalletIcon },
  { id: 'recipes', label: 'Recipes', Icon: BookIcon },
  { id: 'settings', label: 'More', Icon: GearIcon },
];

/**
 * Install is a seventh tab, and only while it means something.
 *
 * It takes the bar to about 53px a tab, which still clears a touch target but is
 * past what the six above were spaced for — so it earns its place by leaving. It
 * is there in a browser, where installing is a thing you have not done yet, and
 * gone in the installed app and the Android build, where it would be a permanent
 * tab devoted to an action already taken.
 */
const INSTALL_TAB = { id: 'install' as const, label: 'Install', Icon: DownloadIcon };

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('plan');
  const state = useAppState();
  const install = useInstallState();

  // Kept while the user is standing on it, even once installed — pulling the tab
  // out from under someone the instant they succeed replaces the confirmation
  // with a jump to another screen, which reads as a glitch rather than a result.
  // It is gone the next time the app opens, which is what the screen promises.
  const showInstall = install.kind !== 'installed' || tab === 'install';
  const tabs = showInstall ? [...TABS, INSTALL_TAB] : TABS;
  const current = tabs.some((t) => t.id === tab) ? tab : 'plan';

  if (!state.ready) {
    return (
      <div className="app">
        <div className="empty" style={{ marginTop: '35vh' }}>
          <div className="spinner" style={{ margin: '0 auto 16px' }} />
          <p>Loading your kitchen…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {current === 'plan' && <PlanScreen state={state} onShop={() => setTab('grocery')} />}
      {current === 'grocery' && <GroceryScreen state={state} onPlan={() => setTab('plan')} />}
      {current === 'cook' && <CookScreen state={state} />}
      {current === 'budget' && <BudgetScreen state={state} />}
      {current === 'recipes' && <RecipesScreen state={state} />}
      {current === 'settings' && <SettingsScreen state={state} />}
      {current === 'install' && <InstallScreen />}

      <nav className="tabs">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={current === id ? 'page' : undefined}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
