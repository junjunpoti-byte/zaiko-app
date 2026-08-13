import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // eslint-disable-next-line no-console
  console.error(
    "Supabase の URL / anon key が設定されていません。.env ファイルを作成し、.env.example を参考に設定してください。"
  );
}

export const supabase = createClient(url, anonKey);
