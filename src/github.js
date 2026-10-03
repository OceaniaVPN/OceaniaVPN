async function ghRequest(cfg, method, endpoint, body = null, options = {}) {
  const url = `https://api.github.com/repos/${cfg.configRepoOwner}/${cfg.configRepoName}${endpoint}`;
  const headers = {
    Authorization: `token ${cfg.githubToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "OceaniaVPN-Bot",
  };
  if (body) headers["Content-Type"] = "application/json";

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`GitHub API ${method} ${endpoint}: HTTP ${response.status}, invalid JSON`);
  }

  if (!response.ok) {
    if (response.status === 404 && options.allowNotFound) return null;

    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = response.headers.get("x-ratelimit-reset");
    const detail = data?.message || `HTTP ${response.status}`;
    console.error("[GitHub] Request failed:", {
      method,
      endpoint,
      status: response.status,
      detail,
      rateLimitRemaining: remaining,
      rateLimitReset: reset,
    });

    const rateInfo = remaining === "0" && reset ? `; rate limit reset at ${new Date(Number(reset) * 1000).toISOString()}` : "";
    throw new Error(`GitHub API ${method} failed: ${detail}${rateInfo}`);
  }

  return data;
}

export async function getFileSha(cfg, filename) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`, null, { allowNotFound: true });
  return data?.sha || null;
}

export async function createOrUpdateFile(cfg, filename, content, message) {
  const sha = await getFileSha(cfg, filename);
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  return ghRequest(cfg, "PUT", `/contents/${cfg.configsFolder}/${filename}`, body);
}

export async function deleteFile(cfg, filename, message) {
  const sha = await getFileSha(cfg, filename);
  if (!sha) return { message: "File not found" };
  return ghRequest(cfg, "DELETE", `/contents/${cfg.configsFolder}/${filename}`, {
    message, sha, branch: cfg.branch,
  });
}

export async function getFileContent(cfg, filename) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`, null, { allowNotFound: true });
  if (!data?.content) return null;
  try {
    return decodeURIComponent(escape(atob(data.content.replace(/\n/g, ""))));
  } catch {
    return null;
  }
}

export async function listAllUsers(cfg) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}?ref=${cfg.branch}`);
  if (!Array.isArray(data)) return [];
  return data.filter((f) => f.type === "file" && f.name.startsWith("user_")).map((f) => f.name);
}

export async function listProxyFiles(cfg) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}?ref=${cfg.branch}`);
  if (!Array.isArray(data)) return [];
  return data
    .filter((f) => f.type === "file" && f.name.startsWith("proxy_") && f.name.endsWith(".txt"))
    .map((f) => ({ name: f.name, size: f.size || 0 }));
}
