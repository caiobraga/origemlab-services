import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import WebSocket from "ws";

export function mustGetSupabaseEnv(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.VITE_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in env");
  }
  return { url, key };
}

export function createSupabase(): SupabaseClient {
  const { url, key } = mustGetSupabaseEnv();
  const hasNativeWs = typeof (globalThis as any).WebSocket !== "undefined";
  return createClient(url, key, {
    auth: { persistSession: false },
    ...(hasNativeWs
      ? {}
      : {
          realtime: {
            transport: WebSocket,
          },
        }),
  });
}

