import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

function tryLoad(p, override = false) {
  if (!p) return false;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  if (!fs.existsSync(abs)) return false;
  dotenv.config({ path: abs, override });
  return true;
}

export function loadEnv() {
  if (process.env.ENV_FILE) {
    tryLoad(process.env.ENV_FILE, true);
    return;
  }
  // Shared repo env (origemlab-services/.env) quando roda de services/document-processor
  const shared = path.resolve(process.cwd(), "..", "..", ".env");
  tryLoad(shared, false);
  // .env na pasta do serviço sobrescreve o shared
  tryLoad(".env", true);
}
