import { Client } from "tunnelfetch";
import { connect } from "cloudflare:sockets";

/**
 * HTTPS-over-proxy transport for Cloudflare Workers.
 *
 * Cloudflare Sockets' native startTls() cannot reliably set the origin SNI
 * after a SOCKS5/HTTP CONNECT tunnel on production edge. tunnelfetch performs
 * TLS in userland and validates the certificate before exposing the response.
 */
export async function fetchThroughProxy(url, proxyUrl, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 8000);
  const client = new Client({
    connect,
    proxy: proxyUrl,
    forceTunnel: true,
    http2: false,
    timeouts: {
      connectMs: timeoutMs,
      handshakeMs: timeoutMs,
      headersMs: timeoutMs,
      idleMs: timeoutMs,
      totalMs: timeoutMs,
    },
  });

  try {
    const response = await client.fetch(url, {
      method: "GET",
      headers: options.headers || {},
      redirect: "manual",
    });

    if (options.probeOnly) {
      return new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // Buffer before closing the client: the returned Response must not depend
    // on a socket that has already been closed.
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    try { await client.close(); } catch {}
  }
}
