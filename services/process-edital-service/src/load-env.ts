import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

function tryLoad(p: string | undefined, override = false): boolean {
  if (!p) return false;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) return false;
  dotenv.config({ path: abs, override });
  return true;
}

// Load on import (mirrors originlab scripts behavior).
(() => {
  if (process.env.ENV_FILE) {
    tryLoad(process.env.ENV_FILE, true);
    return;
  }
  // Shared repo env (origemlab-services/.env) when running from services/<service>
  const shared = path.resolve(process.cwd(), "..", "..", ".env");
  tryLoad(shared, false);
  // Service-local .env overrides shared
  tryLoad(".env", true);
})();

