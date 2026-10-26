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
  const requestUrl = new URL(url);
  // A workers.dev subscription endpoint supports HTTP/2. When routed through
  // the explicit proxy tunnel, offer only h2 for that destination so ALPN
  // cannot silently settle on HTTP/1.1. Other origins keep normal negotiation.
  const requireHttp2 = requestUrl.protocol === "https:" &&
    requestUrl.hostname.toLowerCase().endsWith(".workers.dev");

  const client = new Client({
    connect,
    proxy: proxyUrl,
    forceTunnel: true,
    http2: true,
    ...(requireHttp2 ? { tls: { alpn: ["h2"] } } : {}),
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

    const transport = response.tunnelfetch || {};
    console.log(JSON.stringify({
      event: "proxy_fetch_transport",
      host: requestUrl.hostname,
      httpVersion: transport.httpVersion || null,
      tlsMetadataAvailable: Boolean(transport.tls),
      http2Required: requireHttp2,
    }));
    if (requireHttp2 && transport.httpVersion && String(transport.httpVersion) !== "2") {
      throw new Error(`HTTP/2 was required for workers.dev but negotiated HTTP/${transport.httpVersion}`);
    }

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
    const noBodyStatus = [204, 205, 304].includes(response.status);
    return new Response(noBodyStatus ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    try { await client.close(); } catch {}
  }
}
