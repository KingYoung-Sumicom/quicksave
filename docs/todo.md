# Future Enhancements

## WebRTC Relay-Free Transport

**Status**: Planned

The relay currently proxies all data through the signaling server (WebSocket relay). This works reliably through any firewall that allows HTTPS, with ~50ms connection time and zero ICE/STUN overhead.

A future enhancement would add WebRTC as an **optional upgrade path**:

1. Peers connect via WebSocket relay (instant, always works)
2. In the background, attempt a WebRTC direct connection (ICE/STUN)
3. If ICE succeeds, transparently switch data flow to the direct WebRTC connection
4. If ICE fails (symmetric NAT, corporate firewall), stay on WebSocket relay

This gives the best of both worlds:
- **Reliability**: WebSocket relay as the guaranteed fallback
- **Performance**: Direct p2p when network topology allows (lower latency, no server bandwidth cost)

### Design Notes

- The `ws-relay` package should keep the transport layer swappable — the `Peer` abstraction should not assume WebSocket-only
- ICE candidate exchange can flow through the existing relay as signaling messages
- The upgrade should be transparent to application code (same message API)
- Consider using `simple-peer` or raw `RTCPeerConnection` for the WebRTC layer
