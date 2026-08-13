import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";
import dotenv from "dotenv";

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn("⚠️ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
}

// We need the service role key to bypass RLS since this is a backend microservice
export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false },
  global: {
    fetch: fetch,
  },
  realtime: {
    transport: WebSocket
  }
});
