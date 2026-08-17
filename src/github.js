async function ghRequest(cfg, method, endpoint, body = null) {
  const url = `https://api.github.com/repos/${cfg.configRepoOwner}/${cfg.configRepoName}${endpoint}`;
  const headers = {
    Authorization: `token ${cfg.githubToken}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "OceaniaVPN-Bot",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
    return fetch(url, { method, headers, body: JSON.stringify(body) }).then((r) => r.json());
  }
  return fetch(url, { method, headers }).then((r) => r.json());
}

export async function getFileSha(cfg, filename) {
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`);
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
  const data = await ghRequest(cfg, "GET", `/contents/${cfg.configsFolder}/${filename}?ref=${cfg.branch}`);
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
