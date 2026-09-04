import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { ensureSeeded } from './db/repository';
import './styles.css';

/**
 * Seeding happens before first paint so the app never renders an empty library
 * and then pops content in. It is idempotent and cheap after the first run.
 */
void ensureSeeded()
  .catch((err: unknown) => {
    console.error('Failed to seed the recipe library', err);
  })
  .finally(() => {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
