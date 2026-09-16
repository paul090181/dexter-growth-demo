const DEFAULT_GRAPH_VERSION = "v26.0";

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
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

function friendlyGraphError(data, fallback = "Facebook request failed.") {
  const err = data?.error;
  if (!err) return fallback;
  if (err.code === 190) return "Facebook authorization expired. Refresh the GrowthWise Page access token in Meta, update the Netlify environment variable, and try again.";
  if (err.code === 200) return "Facebook rejected the Page permission. Confirm the connected Page token has pages_read_engagement and pages_manage_posts and that the Facebook account has sufficient Page access.";
  return err.message || fallback;
}

async function graphRequest(path, token, version, options = {}) {
  const response = await fetch(`https://graph.facebook.com/${version}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  return { ok: response.ok, status: response.status, data };
}

function normalizeImages(body) {
  const many = Array.isArray(body?.image_data_urls) ? body.image_data_urls : [];
  const one = body?.image_data_url ? [body.image_data_url] : [];
  return (many.length ? many : one).map(v => String(v || "")).filter(Boolean).slice(0, 4);
}

function imageBlob(dataUrl) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return { error: "Facebook photos must be PNG or JPG images." };
  const bytes = Buffer.from(parsed.base64, "base64");
  if (!bytes.length) return { error: "A selected Facebook photo was empty." };
  if (bytes.length > 5 * 1024 * 1024) return { error: "A selected Facebook photo is too large. Please choose a smaller image." };
  return { parsed, bytes };
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-GrowthWise-Key" } });
  }
  if (request.method !== "GET" && request.method !== "POST") return json(405, { error: "Method not allowed" });

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const pageAccessToken = Netlify.env.get("FACEBOOK_PAGE_ACCESS_TOKEN");
  const pageId = Netlify.env.get("FACEBOOK_PAGE_ID");
  const graphVersion = Netlify.env.get("FACEBOOK_GRAPH_VERSION") || DEFAULT_GRAPH_VERSION;
  if (!adminKey || !pageAccessToken || !pageId) return json(500, { error: "Facebook publishing is not configured yet.", required_environment_variables: ["GROWTHWISE_ADMIN_KEY", "FACEBOOK_PAGE_ACCESS_TOKEN", "FACEBOOK_PAGE_ID"] });

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) return json(401, { error: "Invalid GrowthWise admin key." });

  const pageCheck = await graphRequest(`/${encodeURIComponent(pageId)}?fields=id,name`, pageAccessToken, graphVersion, { method: "GET" });
  if (!pageCheck.ok) return json(pageCheck.status || 502, { error: friendlyGraphError(pageCheck.data, "Could not verify the connected Facebook Page."), facebook: pageCheck.data });
  const pageName = pageCheck.data?.name || "Connected Facebook Page";

  if (request.method === "GET") return json(200, { ok: true, connected: true, page_id: pageId, page_name: pageName, graph_version: graphVersion, multi_photo_supported: true, max_photos: 4 });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Invalid JSON body." }); }
  const message = String(body?.message || "").trim();
  const expectedPageName = String(body?.expected_page_name || "").trim();
  if (expectedPageName && pageName.trim().toLowerCase() !== expectedPageName.toLowerCase()) {
    return json(409, { error: `Publishing blocked: this pilot expected “${expectedPageName}” but the connected Page is “${pageName}”.`, page_name: pageName });
  }
  if (!message) return json(400, { error: "Facebook caption is required." });
  if (message.length > 5000) return json(400, { error: "Facebook caption is too long for this GrowthWise beta." });

  const images = normalizeImages(body);
  if (!images.length) {
    const form = new URLSearchParams(); form.set("message", message);
    const result = await graphRequest(`/${encodeURIComponent(pageId)}/feed`, pageAccessToken, graphVersion, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (!result.ok) return json(result.status || 502, { error: friendlyGraphError(result.data, "Facebook could not publish the post."), facebook: result.data });
    return json(200, { ok: true, message: "Facebook post published.", page_id: pageId, page_name: pageName, post_type: "text", post_id: result.data?.id || null, photo_count: 0, facebook: result.data });
  }

  if (images.length === 1) {
    const prepared = imageBlob(images[0]); if (prepared.error) return json(400, { error: prepared.error });
    const form = new FormData(); form.append("message", message); form.append("published", "true");
    form.append("source", new Blob([prepared.bytes], { type: prepared.parsed.mime }), prepared.parsed.mime === "image/png" ? "growthwise-vehicle.png" : "growthwise-vehicle.jpg");
    const result = await graphRequest(`/${encodeURIComponent(pageId)}/photos`, pageAccessToken, graphVersion, { method: "POST", body: form });
    if (!result.ok) return json(result.status || 502, { error: friendlyGraphError(result.data, "Facebook could not publish the photo post."), facebook: result.data });
    return json(200, { ok: true, message: "Facebook photo post published.", page_id: pageId, page_name: pageName, post_type: "photo", post_id: result.data?.post_id || result.data?.id || null, photo_count: 1, facebook: result.data });
  }

  // Multi-photo Page post: upload each photo unpublished, then attach the returned media IDs to one feed post.
  const mediaIds = [];
  for (let i = 0; i < images.length; i += 1) {
    const prepared = imageBlob(images[i]); if (prepared.error) return json(400, { error: prepared.error });
    const photoForm = new FormData(); photoForm.append("published", "false");
    photoForm.append("source", new Blob([prepared.bytes], { type: prepared.parsed.mime }), `growthwise-vehicle-${i + 1}.${prepared.parsed.mime === "image/png" ? "png" : "jpg"}`);
    const uploaded = await graphRequest(`/${encodeURIComponent(pageId)}/photos`, pageAccessToken, graphVersion, { method: "POST", body: photoForm });
    if (!uploaded.ok || !uploaded.data?.id) return json(uploaded.status || 502, { error: friendlyGraphError(uploaded.data, `Facebook could not prepare campaign photo ${i + 1}.`), facebook: uploaded.data, uploaded_photo_count: mediaIds.length });
    mediaIds.push(String(uploaded.data.id));
  }

  const feedForm = new URLSearchParams(); feedForm.set("message", message);
  mediaIds.forEach((id, i) => feedForm.set(`attached_media[${i}]`, JSON.stringify({ media_fbid: id })));
  const result = await graphRequest(`/${encodeURIComponent(pageId)}/feed`, pageAccessToken, graphVersion, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: feedForm });
  if (!result.ok) return json(result.status || 502, { error: friendlyGraphError(result.data, "Facebook could not publish the multi-photo campaign."), facebook: result.data, uploaded_photo_count: mediaIds.length });

  return json(200, { ok: true, message: "Facebook multi-photo campaign published.", page_id: pageId, page_name: pageName, post_type: "multi_photo", post_id: result.data?.id || null, photo_count: mediaIds.length, facebook: result.data });
};
