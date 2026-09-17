// Happ-compatible request profiles.
// This improves subscription compatibility; it does not spoof TLS.

const PROFILES = [
  {
    name: "Happ Android",
    userAgent: "Happ/3.26.3 Android/15",
    platform: "Android"
  },
  {
    name: "Happ iOS",
    userAgent: "Happ/3.26.3 iOS/18.6",
    platform: "iOS"
  }
];

export function getClientProfile(seed = 0) {
  return PROFILES[Math.abs(seed) % PROFILES.length];
}

export function buildStableDeviceId(seed = "default") {
  let hash = 0;
  for (const c of String(seed)) hash = ((hash << 5) - hash) + c.charCodeAt(0);
  return Math.abs(hash).toString(16);
}
