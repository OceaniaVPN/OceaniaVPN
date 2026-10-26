import net from "node:net";
import { connect as tlsConnect } from "node:tls";
import { Readable, Writable } from "node:stream";

/**
 * Node's Workers-compatible net/tls sockets allow TLS to be layered over an
 * already-established tunnel (required for HTTPS subscriptions via an HTTPS proxy).
 * The project's compatibility date (2026-08-16) includes Node net/tls support.
 */
function wrapSocket(raw, opened) {
  return {
    raw,
    readable: Readable.toWeb(raw),
    writable: Writable.toWeb(raw),
    opened,
    async close() {
      try { raw.destroy(); } catch {}
    },
  };
}

export function connectTcpSocket(hostname, port) {
  const raw = net.connect({ host: hostname, port });
  const opened = new Promise((resolve, reject) => {
    raw.once("connect", resolve);
    raw.once("error", reject);
  });
  return wrapSocket(raw, opened);
}

export function upgradeSocketToTls(socket, hostname) {
  const options = { socket: socket.raw };
  // SNI is a DNS name; omit it for an IP literal.
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) && !hostname.includes(":")) {
    options.servername = hostname;
  }
  const raw = tlsConnect(options);
  const opened = new Promise((resolve, reject) => {
    raw.once("secureConnect", resolve);
    raw.once("error", reject);
  });
  return wrapSocket(raw, opened);
}
