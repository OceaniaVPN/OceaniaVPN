import { connect } from "cloudflare:sockets";

/**
 * Cloudflare Workers native TCP socket adapter.
 * Use cloudflare:sockets rather than node:net/node:tls: Workers do not expose
 * arbitrary Node TCP sockets as a reliable outbound transport.
 */
function wrapSocket(raw) {
  return {
    raw,
    readable: raw.readable,
    writable: raw.writable,
    opened: raw.opened,
    async close() {
      try { await raw.close(); } catch {}
    },
  };
}

export function connectTcpSocket(hostname, port) {
  const raw = connect({ hostname, port }, { secureTransport: "off", allowHalfOpen: false });
  return wrapSocket(raw);
}

export function upgradeSocketToTls(socket, hostname) {
  // startTls upgrades an already-connected Cloudflare socket (including a
  // socket after HTTP CONNECT / SOCKS5 negotiation). It returns a new socket.
  const raw = socket.raw.startTls({ expectedServerHostname: hostname });
  return wrapSocket(raw);
}
