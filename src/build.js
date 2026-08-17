export function buildFile(state, uris = [], defaults = {}) {
  const lines = [];
  const title = state.title || defaults.title || "My Subscription";
  const interval = state.interval || defaults.interval || 4;
  
  lines.push(`#profile-title: ${title}`);
  lines.push(`#profile-update-interval: ${interval}`);
  lines.push(`#subscription-userinfo: upload=0; download=0; total=536870912000; expire=0`);
  
  if (state.webpage) lines.push(`#profile-web-page-url: ${state.webpage}`);
  if (state.announce) lines.push(`#announce: ${state.announce}`);
  
  lines.push("");
  if (uris.length > 0) lines.push(...uris);
  
  return lines.join("\n");
}
