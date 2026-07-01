# CommonView

A minimal peer-to-peer web app. Everyone who opens the page becomes a peer in a
single shared network. Peers discover each other over **nostr** relays and
communicate over **WebRTC** (full mesh). It borrows the discovery/signaling
approach from [trystero](https://github.com/dmotz/trystero)'s nostr strategy,
but only the parts needed here.

For now the shared state is just a counter — a stand-in for the richer state
(including binary blobs) planned later.

## How it works

- **Identity** ([src/p2p/identity.ts](src/p2p/identity.ts)) — each peer has a
  secp256k1 / BIP340 (schnorr) keypair, persisted in `localStorage`. The x-only
  public key **is** the peer ID. The same key signs every nostr event and every
  application message.
- **Discovery/signaling** ([src/p2p/nostr.ts](src/p2p/nostr.ts)) — peers
  announce on a hashed "root topic" and listen there to find each other. WebRTC
  offers/answers/ICE are delivered to a per-peer topic. Only ephemeral nostr
  event kinds are used, so nothing is stored on relays.
- **WebRTC** ([src/p2p/peer.ts](src/p2p/peer.ts)) — a trimmed data-channel
  wrapper. Glare is avoided by letting only the peer with the smaller ID make
  the offer.
- **Mesh + state** ([src/p2p/network.ts](src/p2p/network.ts)) — every peer
  connects to every other peer. On connect, peers exchange a self-reported
  timestamp of when they joined. The **oldest** peer (earliest timestamp, ties
  broken by ID) is the **central** peer and holds the authoritative state.
  - Commands (`+`/`−`) are sent to the central peer, which applies them and
    broadcasts the new state to everyone.
  - Every message is a signed envelope (`{data, from, sig}`) and is verified on
    receipt.
  - If the central peer leaves, the next-oldest peer becomes central and its
    last-known state becomes the source of truth.
  - A page reload, or losing and regaining the network, is a **reconnect** (new
    timestamp). State is never persisted, so once all peers leave it resets.

## Run

```
npm install
npm run dev
```

Open the printed URL in **two different browsers or profiles** (two tabs in the
same profile share the same `localStorage` key, so they'd be the *same* peer).
Watch the roster populate and the counter stay in sync.
