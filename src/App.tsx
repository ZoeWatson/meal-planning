import { useState } from 'react';

import { useAppState } from './state/useAppState';
import { PlanScreen } from './screens/PlanScreen';
import { GroceryScreen } from './screens/GroceryScreen';
import { BudgetScreen } from './screens/BudgetScreen';
import { RecipesScreen } from './screens/RecipesScreen';
import { CookScreen } from './screens/CookScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { BookIcon, CalendarIcon, CartIcon, GearIcon, PotIcon, WalletIcon } from './components/icons';

type Tab = 'plan' | 'grocery' | 'cook' | 'budget' | 'recipes' | 'settings';

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

export function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('plan');
  const state = useAppState();

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
      {tab === 'plan' && <PlanScreen state={state} onShop={() => setTab('grocery')} />}
      {tab === 'grocery' && <GroceryScreen state={state} onPlan={() => setTab('plan')} />}
      {tab === 'cook' && <CookScreen state={state} />}
      {tab === 'budget' && <BudgetScreen state={state} />}
      {tab === 'recipes' && <RecipesScreen state={state} />}
      {tab === 'settings' && <SettingsScreen state={state} />}

      <nav className="tabs">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? 'page' : undefined}
          >
            <Icon />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
