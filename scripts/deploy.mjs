import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureD1 } from "./ensure-d1.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args) {
  console.log("\n[Deploy] " + command + " " + args.join(" "));
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(command + " failed with exit code " + String(result.status));
}

try {
  await ensureD1();
  run("npx", ["wrangler", "d1", "migrations", "apply", "BOT_DB", "--remote"]);
  run("npx", ["wrangler", "deploy"]);
  console.log("[Deploy] StekloVPN deployed successfully.");
} catch (error) {
  console.error("[Deploy] Failed:", error?.stack || error);
  process.exitCode = 1;
}
