// A thin WebRTC wrapper, distilled from trystero's peer.ts. We only need a
// reliable ordered data channel plus offer/answer/ICE signaling. To keep things
// simple we avoid "perfect negotiation" glare handling by ensuring only ONE
// side (a deterministically chosen initiator) ever creates the offer.

export type Signal =
  | {type: 'offer'; sdp: string}
  | {type: 'answer'; sdp: string}
  | {type: 'candidate'; candidate: RTCIceCandidateInit}

export interface PeerHandlers {
  signal: (signal: Signal) => void
  connect: () => void
  data: (data: string) => void
  close: () => void
}

const ICE_SERVERS: RTCIceServer[] = [
  {urls: 'stun:stun.l.google.com:19302'},
  {urls: 'stun:stun1.l.google.com:19302'},
  {urls: 'stun:stun.cloudflare.com:3478'}
]

export class Peer {
  private pc: RTCPeerConnection
  private channel: RTCDataChannel | null = null
  private handlers: Partial<PeerHandlers> = {}
  private pendingCandidates: RTCIceCandidateInit[] = []
  private closed = false

  constructor(private initiator: boolean) {
    this.pc = new RTCPeerConnection({iceServers: ICE_SERVERS})

    this.pc.onicecandidate = ({candidate}) => {
      if (candidate) {
        this.handlers.signal?.({type: 'candidate', candidate: candidate.toJSON()})
      }
    }

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState
      if (s === 'failed' || s === 'closed' || s === 'disconnected') {
        this.destroy()
      }
    }

    if (initiator) {
      this.setupChannel(this.pc.createDataChannel('data'))
      this.pc.onnegotiationneeded = () => void this.makeOffer()
    } else {
      this.pc.ondatachannel = ({channel}) => this.setupChannel(channel)
    }
  }

  setHandlers(handlers: Partial<PeerHandlers>) {
    Object.assign(this.handlers, handlers)
  }

  private setupChannel(channel: RTCDataChannel) {
    this.channel = channel
    channel.onopen = () => this.handlers.connect?.()
    channel.onclose = () => this.destroy()
    channel.onmessage = e => this.handlers.data?.(e.data as string)
  }

  private async makeOffer() {
    if (this.closed) return
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer())
      this.handlers.signal?.({
        type: 'offer',
        sdp: this.pc.localDescription!.sdp
      })
    } catch {
      /* ignore */
    }
  }

  async signal(signal: Signal) {
    if (this.closed) return
    try {
      if (signal.type === 'candidate') {
        if (this.pc.remoteDescription) {
          await this.pc.addIceCandidate(signal.candidate)
        } else {
          this.pendingCandidates.push(signal.candidate)
        }
        return
      }

      if (signal.type === 'offer') {
        if (this.initiator) return // initiators never accept remote offers
        await this.pc.setRemoteDescription({type: 'offer', sdp: signal.sdp})
        await this.flushCandidates()
        await this.pc.setLocalDescription(await this.pc.createAnswer())
        this.handlers.signal?.({
          type: 'answer',
          sdp: this.pc.localDescription!.sdp
        })
        return
      }

      if (signal.type === 'answer') {
        await this.pc.setRemoteDescription({type: 'answer', sdp: signal.sdp})
        await this.flushCandidates()
      }
    } catch {
      /* ignore transient signaling errors */
    }
  }

  private async flushCandidates() {
    const queued = this.pendingCandidates.splice(0)
    for (const c of queued) {
      try {
        await this.pc.addIceCandidate(c)
      } catch {
        /* ignore */
      }
    }
  }

  send(data: string) {
    if (this.channel?.readyState === 'open') this.channel.send(data)
  }

  get isConnected(): boolean {
    return this.channel?.readyState === 'open'
  }

  destroy() {
    if (this.closed) return
    this.closed = true
    try {
      this.channel?.close()
    } catch {
      /* ignore */
    }
    try {
      this.pc.close()
    } catch {
      /* ignore */
    }
    this.handlers.close?.()
  }
}
