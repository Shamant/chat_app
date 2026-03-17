import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const supabaseReady = Boolean(supabaseUrl) && Boolean(supabaseAnonKey);

const supabase = supabaseReady
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export { supabase, supabaseReady };
