/**
 * Minimal .env loader (side-effect import; no dotenv dependency).
 * Looks for draft-agent/.env, then fantasy-engine/.env. Existing environment
 * variables always win, so Claude Desktop's env block overrides the files.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [join(moduleRoot, ".env"), join(moduleRoot, "..", ".env")]) {
  if (!existsSync(file)) continue;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
