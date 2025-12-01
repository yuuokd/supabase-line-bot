import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// サービスロールキーで Supabase クライアントを生成するヘルパー。
// 利用シーン: Edge Functions から DB をフルアクセス（service_role で RLS をバイパス）するときに使う。
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
