import { useState } from 'react';

import { useAppState } from './state/useAppState';
import { PlanScreen } from './screens/PlanScreen';
import { GroceryScreen } from './screens/GroceryScreen';
import { RecipesScreen } from './screens/RecipesScreen';
import { KitchenScreen } from './screens/KitchenScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { BookIcon, CalendarIcon, CartIcon, GearIcon, JarIcon } from './components/icons';

type Tab = 'plan' | 'grocery' | 'recipes' | 'kitchen' | 'settings';

const TABS: ReadonlyArray<{ id: Tab; label: string; Icon: (p: { size?: number }) => JSX.Element }> = [
  { id: 'plan', label: 'Week', Icon: CalendarIcon },
  { id: 'grocery', label: 'Shop', Icon: CartIcon },
  { id: 'recipes', label: 'Recipes', Icon: BookIcon },
  { id: 'kitchen', label: 'Kitchen', Icon: JarIcon },
  { id: 'settings', label: 'Settings', Icon: GearIcon },
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
      {tab === 'recipes' && <RecipesScreen state={state} />}
      {tab === 'kitchen' && <KitchenScreen state={state} />}
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
