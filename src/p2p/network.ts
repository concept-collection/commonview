import {selfId, sign, verify} from './identity'
import {Nostr, peerTopic, rootTopic} from './nostr'
import {Peer, type Signal} from './peer'

// ---------------------------------------------------------------------------
// Application state + commands. For this first version the shared state is just
// a single counter. Commands are dispatched to the central peer, which applies
// them to the authoritative state and broadcasts the result.
// ---------------------------------------------------------------------------

export interface AppState {
  counter: number
}

export type Command = {op: 'increment'} | {op: 'decrement'}

const initialState = (): AppState => ({counter: 0})

const applyCommand = (state: AppState, cmd: Command): AppState => {
  switch (cmd.op) {
    case 'increment':
      return {counter: state.counter + 1}
    case 'decrement':
      return {counter: state.counter - 1}
    default:
      return state
  }
}

// ---------------------------------------------------------------------------
// Wire protocol (over the WebRTC data channel). Every message is a signed
// envelope: `data` is the exact JSON string that was signed, `from` is the
// sender's peer ID (public key), and `sig` is the schnorr signature.
// ---------------------------------------------------------------------------

type Message =
  | {t: 'hello'; connectedAt: number}
  | {t: 'command'; cmd: Command; forwarded?: boolean}
  | {t: 'state'; state: AppState; version: number}

interface Envelope {
  data: string
  from: string
  sig: string
}

// ---------------------------------------------------------------------------

export interface RosterEntry {
  peerId: string
  connectedAt: number
  isSelf: boolean
  isCentral: boolean
}

export interface Snapshot {
  selfId: string
  connectedAt: number
  centralId: string | null
  amCentral: boolean
  roster: RosterEntry[]
  state: AppState
  version: number
}

const ANNOUNCE_INTERVAL_MS = 5000
const ROOM_ID = 'default'
// A connection attempt that hasn't opened after this long is torn down and
// retried on the peer's next announcement. Signaling events are ephemeral, so
// an offer published before the other side was listening is simply lost —
// without a retry the pair would deadlock forever.
const CONNECT_RETRY_MS = 15000

interface Connection {
  peer: Peer
  /** When this connection attempt started (local clock), for retry pacing. */
  createdAt: number
  connectedAt: number | null // self-reported timestamp from the remote peer
}

export class Network {
  private nostr = new Nostr()
  private root = ''
  private connections = new Map<string, Connection>()

  private connectedAt = Date.now()
  private state: AppState = initialState()
  private version = 0

  private snapshot!: Snapshot
  private listeners = new Set<() => void>()

  constructor() {
    this.rebuildSnapshot()
    void this.start()

    window.addEventListener('online', () => {
      // Regaining a connection counts as a reconnect: new timestamp.
      this.connectedAt = Date.now()
      this.broadcastHello()
      this.recompute()
    })
  }

  private async start() {
    this.root = await rootTopic(ROOM_ID)

    // Receive WebRTC signaling addressed to us.
    const selfSignalTopic = await peerTopic(this.root, selfId)
    this.nostr.subscribe(selfSignalTopic, (content, from) => {
      if (from === selfId) return
      let signal: Signal
      try {
        signal = JSON.parse(content)
      } catch {
        return
      }
      this.handleSignal(from, signal)
    })

    // Discover peers via announcements on the root topic.
    this.nostr.subscribe(this.root, (content, from) => {
      if (from === selfId) return
      let ann: {peerId?: string}
      try {
        ann = JSON.parse(content)
      } catch {
        return
      }
      if (ann.peerId && ann.peerId === from) this.maybeConnect(from)
    })

    const announce = () =>
      void this.nostr.publish(this.root, JSON.stringify({peerId: selfId}))
    announce()
    setInterval(announce, ANNOUNCE_INTERVAL_MS)
  }

  // ---- connection setup -------------------------------------------------

  private maybeConnect(peerId: string) {
    if (peerId === selfId) return
    const existing = this.connections.get(peerId)
    if (existing) {
      const stalled =
        !existing.peer.isConnected &&
        Date.now() - existing.createdAt > CONNECT_RETRY_MS
      if (!stalled) return
      // destroy() fires the close handler, which removes it from the map.
      existing.peer.destroy()
      this.connections.delete(peerId)
    }
    // Deterministic initiator: the peer with the smaller ID makes the offer.
    const initiator = selfId < peerId
    this.createPeer(peerId, initiator)
  }

  private createPeer(peerId: string, initiator: boolean): Connection {
    const peer = new Peer(initiator)
    const conn: Connection = {peer, createdAt: Date.now(), connectedAt: null}
    this.connections.set(peerId, conn)

    peer.setHandlers({
      signal: signal => {
        void this.sendSignal(peerId, signal)
      },
      connect: () => {
        // Tell the new peer our self-reported connect time.
        void this.sendTo(peerId, {t: 'hello', connectedAt: this.connectedAt})
        // If we're central, sync the newcomer immediately.
        if (this.amCentral()) void this.broadcastState()
        this.recompute()
      },
      data: raw => void this.handleData(peerId, raw),
      close: () => {
        if (this.connections.get(peerId)?.peer === peer) {
          this.connections.delete(peerId)
          this.recompute()
        }
      }
    })

    return conn
  }

  private async sendSignal(peerId: string, signal: Signal) {
    const topic = await peerTopic(this.root, peerId)
    void this.nostr.publish(topic, JSON.stringify(signal))
  }

  private handleSignal(from: string, signal: Signal) {
    let conn = this.connections.get(from)
    if (!conn) {
      if (signal.type !== 'offer') return // nothing to attach it to yet
      conn = this.createPeer(from, false)
    }
    void conn.peer.signal(signal)
  }

  // ---- messaging --------------------------------------------------------

  private async sendTo(peerId: string, msg: Message) {
    const conn = this.connections.get(peerId)
    if (!conn) return
    const data = JSON.stringify(msg)
    const sig = await sign(data)
    const env: Envelope = {data, from: selfId, sig}
    conn.peer.send(JSON.stringify(env))
  }

  private async broadcast(msg: Message) {
    const data = JSON.stringify(msg)
    const sig = await sign(data)
    const env: Envelope = {data, from: selfId, sig}
    const payload = JSON.stringify(env)
    for (const conn of this.connections.values()) conn.peer.send(payload)
  }

  private broadcastHello() {
    void this.broadcast({t: 'hello', connectedAt: this.connectedAt})
  }

  private async broadcastState() {
    await this.broadcast({t: 'state', state: this.state, version: this.version})
  }

  private async handleData(from: string, raw: string) {
    let env: Envelope
    try {
      env = JSON.parse(raw)
    } catch {
      return
    }
    // The envelope must be signed by the peer we received it from.
    if (env.from !== from) return
    if (!(await verify(env.data, env.sig, env.from))) return

    let msg: Message
    try {
      msg = JSON.parse(env.data)
    } catch {
      return
    }

    switch (msg.t) {
      case 'hello': {
        const conn = this.connections.get(from)
        if (conn) {
          conn.connectedAt = msg.connectedAt
          this.recompute()
        }
        break
      }
      case 'command': {
        if (this.amCentral()) {
          this.state = applyCommand(this.state, msg.cmd)
          this.version++
          await this.broadcastState()
          this.rebuildSnapshot()
        } else if (!msg.forwarded) {
          // Not central; forward once toward the central peer.
          const central = this.centralId()
          if (central && this.connections.has(central)) {
            void this.sendTo(central, {...msg, forwarded: true})
          }
        }
        break
      }
      case 'state': {
        // Only trust state from the current central peer.
        if (from === this.centralId()) {
          this.state = msg.state
          this.version = msg.version
          this.rebuildSnapshot()
        }
        break
      }
    }
  }

  // ---- central-peer election -------------------------------------------

  /** All peers we know about, with a reported connect time, plus ourselves. */
  private participants(): {peerId: string; connectedAt: number}[] {
    const list = [{peerId: selfId, connectedAt: this.connectedAt}]
    for (const [peerId, conn] of this.connections) {
      if (conn.peer.isConnected && conn.connectedAt !== null) {
        list.push({peerId, connectedAt: conn.connectedAt})
      }
    }
    return list
  }

  /** The oldest peer (smallest connect time; ties broken by peer ID) is central. */
  private centralId(): string | null {
    const list = this.participants()
    if (list.length === 0) return null
    return list.reduce((oldest, p) =>
      p.connectedAt < oldest.connectedAt ||
      (p.connectedAt === oldest.connectedAt && p.peerId < oldest.peerId)
        ? p
        : oldest
    ).peerId
  }

  private amCentral(): boolean {
    return this.centralId() === selfId
  }

  private recompute() {
    const wasCentral = this.snapshot.amCentral
    this.rebuildSnapshot()
    // If we just became central, our last-known state is now the source of
    // truth — push it to everyone.
    if (!wasCentral && this.snapshot.amCentral) void this.broadcastState()
  }

  // ---- public API -------------------------------------------------------

  dispatch(cmd: Command) {
    if (this.amCentral()) {
      this.state = applyCommand(this.state, cmd)
      this.version++
      void this.broadcastState()
      this.rebuildSnapshot()
    } else {
      const central = this.centralId()
      if (central && this.connections.has(central)) {
        void this.sendTo(central, {t: 'command', cmd})
      }
    }
  }

  getSnapshot = (): Snapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private rebuildSnapshot() {
    const centralId = this.centralId()
    const roster: RosterEntry[] = this.participants()
      .map(p => ({
        peerId: p.peerId,
        connectedAt: p.connectedAt,
        isSelf: p.peerId === selfId,
        isCentral: p.peerId === centralId
      }))
      .sort((a, b) => a.connectedAt - b.connectedAt)

    this.snapshot = {
      selfId,
      connectedAt: this.connectedAt,
      centralId,
      amCentral: centralId === selfId,
      roster,
      state: this.state,
      version: this.version
    }
    for (const l of this.listeners) l()
  }
}
