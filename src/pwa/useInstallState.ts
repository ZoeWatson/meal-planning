import { useSyncExternalStore } from 'react';

import { getInstallState, subscribeToInstallState, type InstallState } from './install';

/**
 * The install state, as a hook.
 *
 * Separate from `install.ts` so that module stays free of React and can keep
 * doing the one thing it has to do — register its listener the moment it is
 * imported, long before anything renders.
 */
export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribeToInstallState, getInstallState, getInstallState);
}
