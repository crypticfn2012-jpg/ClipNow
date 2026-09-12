const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS"
};

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return json({ allowed: false, message: "Method not allowed" }, 405);
  }

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return json({ allowed: false, message: "Sign in to moderate media." }, 401);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
    if (!apiKey) {
      console.error("moderate-media: OPENAI_API_KEY secret is missing");
      return json({ allowed: false, message: "Media moderation is not configured: OPENAI_API_KEY is missing in Supabase Secrets." }, 503);
    }

    const body = await req.json().catch(() => ({}));
    const images = Array.isArray(body.images) ? body.images : [];
    if (!images.length || images.length > 6) {
      return json({ allowed: false, message: "Invalid media moderation request." }, 400);
    }

    const safeImages = images.filter((value) =>
      typeof value === "string" && /^data:image\/(jpeg|jpg|png|webp);base64,/i.test(value)
    );
    if (safeImages.length !== images.length) {
      return json({ allowed: false, message: "Invalid media format." }, 400);
    }

    const input = safeImages.map((url) => ({
      type: "image_url",
      image_url: { url }
    }));

    console.log(`moderate-media: sending ${safeImages.length} image(s) to OpenAI`);

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
      const providerMessage = String(result?.error?.message || "Unknown OpenAI API error");
      const providerType = String(result?.error?.type || "");
      const safeDetail = providerType ? `${providerType}: ${providerMessage}` : providerMessage;
      console.error("moderate-media: OpenAI API error", response.status, safeDetail);
      return json({
        allowed: false,
        message: `Media moderation provider error (${response.status}): ${safeDetail}`
      }, 502);
    }

    const results = Array.isArray(result.results) ? result.results : [];
    const blocked = results.some((item: any) => {
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

    return json({
      allowed: !blocked,
      message: blocked ? "This media is not allowed on ClipNow." : "Media approved."
    });
  } catch (error) {
    console.error("moderate-media: unhandled error", error);
    return json({
      allowed: false,
      message: `Media moderation failed: ${error instanceof Error ? error.message : String(error)}`
    }, 500);
  }
});
