import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ allowed: false, message: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ allowed: false, message: "Sign in to moderate media." }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ allowed: false, message: "Media moderation is not configured yet." }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const body = await req.json().catch(() => ({}));
    const images = Array.isArray(body.images) ? body.images : [];
    if (!images.length || images.length > 6) {
      return new Response(JSON.stringify({ allowed: false, message: "Invalid media moderation request." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // Only accept data URLs. This keeps the function from becoming a generic URL fetcher.
    const safeImages = images.filter((value) =>
      typeof value === "string" && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)
    );
    if (safeImages.length !== images.length) {
      return new Response(JSON.stringify({ allowed: false, message: "Invalid media format." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const input = safeImages.map((url) => ({
      type: "image_url",
      image_url: { url }
    }));

    const response = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("OpenAI moderation error", response.status, result);
      return new Response(JSON.stringify({ allowed: false, message: "Media moderation failed. Please try again." }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const results = Array.isArray(result.results) ? result.results : [];
    const blocked = results.some((item) => {
      const categories = item?.categories || {};
      return Boolean(
        categories["sexual"] ||
        categories["sexual/minors"] ||
        categories["violence"] ||
        categories["violence/graphic"] ||
        categories["self-harm"] ||
        categories["self-harm/intent"] ||
        categories["self-harm/instructions"] ||
        categories["hate"] ||
        categories["hate/threatening"]
      );
    });

    return new Response(JSON.stringify({
      allowed: !blocked,
      message: blocked ? "This media is not allowed on ClipNow." : "Media approved."
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  } catch (error) {
    console.error("moderate-media", error);
    return new Response(JSON.stringify({ allowed: false, message: "Media moderation failed. Please try again." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
