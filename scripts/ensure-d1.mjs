import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wranglerPath = path.join(projectRoot, "wrangler.toml");
const apiBase = "https://api.cloudflare.com/client/v4";

function readValue(block, key) {
  const match = block.match(new RegExp("^\\s*" + key + "\\s*=\\s*\"([^\"]*)\"", "m"));
  return match?.[1] || "";
}

function writeValue(block, key, value) {
  const pattern = new RegExp("^(" + key + "\\s*=\\s*)\"[^\"]*\"", "m");
  const quoted = JSON.stringify(String(value));
  if (pattern.test(block)) return block.replace(pattern, (_, prefix) => prefix + quoted);
  return block.trimEnd() + "\n" + key + " = " + quoted + "\n";
}

async function cloudflareRequest(accountId, token, pathName, options = {}) {
  const response = await fetch(apiBase + "/accounts/" + accountId + pathName, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (response.status === 404) return { notFound: true, payload };
  if (!response.ok || payload?.success === false) {
    const messages = (payload?.errors || []).map(item => item.message).filter(Boolean).join("; ");
    throw new Error("Cloudflare API " + response.status + ": " + (messages || response.statusText));
  }
  return payload;
}

function botDbBlock(config) {
  const start = config.indexOf("[[d1_databases]]");
  if (start < 0) throw new Error("wrangler.toml: [[d1_databases]] with binding BOT_DB is missing");
  const next = config.indexOf("\n[", start + 1);
  const end = next < 0 ? config.length : next;
  const block = config.slice(start, end);
  if (readValue(block, "binding") !== "BOT_DB") {
    throw new Error("wrangler.toml: first D1 binding is not BOT_DB");
  }
  return { start, end, block };
}

async function listDatabases(accountId, token) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const data = await cloudflareRequest(accountId, token, "/d1/database?per_page=100&page=" + page);
    const rows = Array.isArray(data.result) ? data.result : [];
    found.push(...rows);
    if (!data.result_info || page >= Number(data.result_info.total_pages || 1)) break;
  }
  return found;
}

export async function ensureD1() {
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
  const token = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();
  const config = await fs.readFile(wranglerPath, "utf8");
  const located = botDbBlock(config);
  const existingId = readValue(located.block, "database_id");
  const configuredName = readValue(located.block, "database_name");

  // Without provisioning credentials, do not replace a configured binding.
  if (!accountId || !token) {
    if (existingId) {
      console.log("[D1] Keeping configured BOT_DB. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to enable automatic recovery/creation.");
      return { databaseId: existingId, databaseName: configuredName, created: false, verified: false };
    }
    throw new Error("D1 is not configured. Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to create and bind BOT_DB.");
  }

  const base = "/d1/database";
  if (existingId) {
    const current = await cloudflareRequest(accountId, token, base + "/" + encodeURIComponent(existingId));
    if (!current.notFound && current.result?.uuid) {
      const actualName = current.result.name || configuredName;
      if (actualName !== configuredName) {
        const updatedBlock = writeValue(located.block, "database_name", actualName);
        await fs.writeFile(wranglerPath, config.slice(0, located.start) + updatedBlock + config.slice(located.end), "utf8");
      }
      console.log("[D1] Reusing existing database: " + actualName + " (" + existingId + ")");
      return { databaseId: existingId, databaseName: actualName, created: false, verified: true };
    }
  }

  const databaseName = String(process.env.D1_DATABASE_NAME || "steklovpn").trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(databaseName)) {
    throw new Error("D1_DATABASE_NAME must contain 1-64 letters, digits, underscores or hyphens.");
  }

  const databases = await listDatabases(accountId, token);
  let database = databases.find(item => item.name === databaseName);
  let created = false;

  if (!database) {
    const jurisdiction = String(process.env.D1_JURISDICTION || "eu").toLowerCase();
    if (!["eu", "us", "fedramp"].includes(jurisdiction)) {
      throw new Error("D1_JURISDICTION must be eu, us or fedramp.");
    }
    const result = await cloudflareRequest(accountId, token, base, {
      method: "POST",
      body: JSON.stringify({ name: databaseName, jurisdiction })
    });
    database = result.result;
    created = true;
  }

  if (!database?.uuid) throw new Error("Cloudflare did not return a D1 database UUID.");

  const updatedBlock = writeValue(
    writeValue(located.block, "database_name", database.name || databaseName),
    "database_id",
    database.uuid
  );
  await fs.writeFile(
    wranglerPath,
    config.slice(0, located.start) + updatedBlock + config.slice(located.end),
    "utf8"
  );

  console.log("[D1] " + (created ? "Created" : "Reused") + " database " + (database.name || databaseName) + " (" + database.uuid + "); BOT_DB is now bound.");
  return { databaseId: database.uuid, databaseName: database.name || databaseName, created, verified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ensureD1().catch(error => {
    console.error("[D1] Provisioning failed:", error?.stack || error);
    process.exitCode = 1;
  });
}
