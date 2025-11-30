import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Factory to create a Supabase server-side client using the service role key.
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
