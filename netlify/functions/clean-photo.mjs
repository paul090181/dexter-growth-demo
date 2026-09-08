function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-GrowthWise-Key",
      },
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const openaiKey = Netlify.env.get("OPENAI_API_KEY");
  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");

  if (!openaiKey || !adminKey) {
    return json(500, { error: "Photo service is not configured yet." });
  }

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) {
    return json(401, { error: "Invalid GrowthWise admin key." });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  const parsed = parseDataUrl(payload.image_data_url);
  if (!parsed) {
    return json(400, { error: "Please upload a PNG, JPG, or WebP image." });
  }

  const bytes = Buffer.from(parsed.base64, "base64");
  if (!bytes.length) {
    return json(400, { error: "The uploaded image was empty." });
  }

  // Keep the request comfortably below common serverless payload limits.
  if (bytes.length > 5 * 1024 * 1024) {
    return json(413, { error: "Image is too large. Please choose a smaller photo." });
  }

  const extension =
    parsed.mime === "image/png" ? "png" :
    parsed.mime === "image/webp" ? "webp" : "jpg";

  const prompt = `
Edit this product photograph for Dexter's Hats, Caps & Things.

PRIMARY GOAL:
Create a polished ecommerce-style product photo of the SAME hat/cap/accessory on a pure white (#FFFFFF) background.

STRICT PRESERVATION:
- Preserve the actual product identity, silhouette, proportions, color, material texture, stitching, hat band, feather, trim, tags, logos, pins, emblems, and branding as faithfully as possible.
- Do not redesign, recolor, relabel, beautify, add, remove, or invent product details.
- Do not add text, prices, graphics, borders, props, hands, people, or extra accessories.

BACKGROUND / DISPLAY CLEANUP:
- Completely remove mannequin heads, mannequin faces, people, stands, shelves, walls, tables, packaging clutter, and distracting background objects.
- If the product was displayed on a mannequin, reconstruct only the portions necessary to show the product naturally by itself.
- Center the product with comfortable white space around it.
- Use a clean pure-white studio background.
- A very subtle realistic grounding shadow is acceptable, but no visible floor, horizon, or backdrop seam.

OUTPUT:
Professional catalog/product photography suitable for Dexter's website and social media. The product itself must remain realistic and recognizable as the exact item in the input photo.
  `.trim();

  try {
    const form = new FormData();
    form.append("model", "gpt-image-2");
    form.append("prompt", prompt);
    form.append("quality", "low");
    form.append("size", "1024x1024");
    form.append("image", new Blob([bytes], { type: parsed.mime }), `dexter-product.${extension}`);

    const response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
      },
      body: form,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `Image service returned HTTP ${response.status}.`;
      return json(response.status, { error: message });
    }

    const imageBase64 = data?.data?.[0]?.b64_json;
    if (!imageBase64) {
      return json(502, { error: "The image service did not return an edited image." });
    }

    return json(200, {
      ok: true,
      image_data_url: `data:image/png;base64,${imageBase64}`,
      model: "gpt-image-2",
      style: "Dexter clean white background",
    });
  } catch (error) {
    console.error("clean-photo failed", error);
    return json(500, {
      error: error?.message || "Could not process the product photo.",
    });
  }
};
