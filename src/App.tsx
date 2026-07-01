import {useNetwork} from './useNetwork'

const short = (id: string) => id.slice(0, 8) + '…' + id.slice(-4)

const time = (ms: number) => new Date(ms).toLocaleTimeString()

export default function App() {
  const {snapshot, dispatch} = useNetwork()
  const {selfId, connectedAt, centralId, amCentral, roster, state, version} =
    snapshot

  return (
    <div style={{fontFamily: 'sans-serif', maxWidth: 640, margin: '2rem auto', padding: '0 1rem'}}>
      <h1>CommonView</h1>

      <section>
        <h2>You</h2>
        <div>ID: <code>{short(selfId)}</code></div>
        <div>Connected at: {time(connectedAt)}</div>
        <div>
          Role:{' '}
          <strong>{amCentral ? 'CENTRAL (source of truth)' : 'peer'}</strong>
        </div>
        <div>
          Central peer:{' '}
          <code>{centralId ? short(centralId) : '(none)'}</code>
        </div>
      </section>

      <section>
        <h2>Shared state</h2>
        <div style={{fontSize: '2rem'}}>counter = {state.counter}</div>
        <div style={{color: '#666', fontSize: '0.85rem'}}>version {version}</div>
        <div style={{marginTop: '0.5rem'}}>
          <button onClick={() => dispatch({op: 'decrement'})}>−</button>{' '}
          <button onClick={() => dispatch({op: 'increment'})}>+</button>
        </div>
        <p style={{color: '#666', fontSize: '0.85rem'}}>
          Commands are sent to the central peer, which updates the authoritative
          state and broadcasts it back to everyone.
        </p>
      </section>

      <section>
        <h2>Peers in room ({roster.length})</h2>
        <table style={{borderCollapse: 'collapse', width: '100%'}}>
          <thead>
            <tr style={{textAlign: 'left'}}>
              <th style={{padding: '0.25rem'}}>ID</th>
              <th style={{padding: '0.25rem'}}>Connected</th>
              <th style={{padding: '0.25rem'}}>Role</th>
            </tr>
          </thead>
          <tbody>
            {roster.map(p => (
              <tr key={p.peerId} style={{background: p.isSelf ? '#f0f0f0' : undefined}}>
                <td style={{padding: '0.25rem'}}>
                  <code>{short(p.peerId)}</code>
                  {p.isSelf ? ' (you)' : ''}
                </td>
                <td style={{padding: '0.25rem'}}>{time(p.connectedAt)}</td>
                <td style={{padding: '0.25rem'}}>
                  {p.isCentral ? 'central' : 'peer'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
