import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// サービスロールキーで Supabase クライアントを生成するヘルパー。
// Edge Functions では service_role を使って RLS をバイパスし、全テーブルへサーバーサイドアクセスする前提。
export const supabaseClient = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    {
      global: {
        headers: { "x-application-name": "line-webhook-edge-func" },
      },
    },
  )
