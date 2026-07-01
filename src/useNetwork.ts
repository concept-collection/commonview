import {useSyncExternalStore} from 'react'
import {Network, type Snapshot} from './p2p/network'

// A single Network instance for the whole app (module-level so React StrictMode
// double-mounting doesn't create two peer networks).
const network = new Network()

export const useNetwork = (): {
  snapshot: Snapshot
  dispatch: Network['dispatch']
} => {
  const snapshot = useSyncExternalStore(network.subscribe, network.getSnapshot)
  return {snapshot, dispatch: cmd => network.dispatch(cmd)}
}
