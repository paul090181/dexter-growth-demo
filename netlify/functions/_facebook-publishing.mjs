const DEFAULT_GRAPH_VERSION = "v26.0";
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class FacebookPublishingError extends Error {
  constructor(code, message, { httpStatus = 502, providerCode = null } = {}) {
    super(message);
    this.name = "FacebookPublishingError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
  }
}

function safeGraphVersion(value) {
  const clean = String(value || "").trim();
  return /^v\\d+\\.\\d+$/.test(clean) ? clean : DEFAULT_GRAPH_VERSION;
}

function cleanPageId(value) {
  const clean = String(value || "").trim();
  if (!clean || clean.length > 200 || !/^[A-Za-z0-9._-]+$/.test(clean)) {
    throw new FacebookPublishingError("FACEBOOK_INVALID_PAGE", "Facebook Page configuration is invalid.", { httpStatus: 409 });
  }
  return clean;
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!match) {
    throw new FacebookPublishingError("FACEBOOK_INVALID_IMAGE", "Facebook photos must be JPG or PNG images.", { httpStatus: 400 });
  }
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) {
    throw new FacebookPublishingError("FACEBOOK_INVALID_IMAGE", "A selected Facebook photo was empty.", { httpStatus: 400 });
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new FacebookPublishingError("FACEBOOK_IMAGE_TOO_LARGE", "A selected Facebook photo is too large. Choose a photo under 5 MB.", { httpStatus: 400 });
  }
  return { mime: match[1], bytes };
}

function normalizeImages({ imageDataUrl = "", imageDataUrls = null } = {}) {
  const values = Array.isArray(imageDataUrls) && imageDataUrls.length
    ? imageDataUrls
    : imageDataUrl
      ? [imageDataUrl]
      : [];
  if (values.length > MAX_IMAGES) {
    throw new FacebookPublishingError(
      "FACEBOOK_TOO_MANY_IMAGES",
      "Facebook publishing supports up to " + MAX_IMAGES + " photos per post.",
      { httpStatus: 400 },
    );
  }
  return values.map((value) => parseDataUrl(value));
}

async function readGraphJson(response) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new FacebookPublishingError("FACEBOOK_PROVIDER_RESPONSE_INVALID", "Facebook returned an unexpected response.", { httpStatus: 502 });
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new FacebookPublishingError("FACEBOOK_PROVIDER_RESPONSE_INVALID", "Facebook returned an unexpected response.", { httpStatus: 502 });
  }
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch {
      throw new FacebookPublishingError("FACEBOOK_PROVIDER_RESPONSE_INVALID", "Facebook returned an unreadable response.", { httpStatus: 502 });
    }
  }
  if (!response.ok) {
    const providerCode = Number.isFinite(Number(data?.error?.code)) ? Number(data.error.code) : null;
    if (providerCode === 190) {
      throw new FacebookPublishingError(
        "FACEBOOK_RECONNECT_REQUIRED",
        "Facebook authorization expired. Reconnect this business's Facebook Page.",
        { httpStatus: 409, providerCode },
      );
    }
    if (providerCode === 200) {
      throw new FacebookPublishingError(
        "FACEBOOK_PUBLISHING_PERMISSION_REQUIRED",
        "Facebook publishing permission needs attention. Reconnect the Page and approve publishing access.",
        { httpStatus: 409, providerCode },
      );
    }
    throw new FacebookPublishingError(
      "FACEBOOK_PUBLISH_FAILED",
      "Facebook could not publish the reviewed post.",
      { httpStatus: response.status || 502, providerCode },
    );
  }
  return data;
}

async function graphRequest({
  fetchImpl,
  graphVersion,
  path,
  pageAccessToken,
  method = "GET",
  headers = {},
  body,
}) {
  const response = await fetchImpl(
    "https://graph.facebook.com/" + safeGraphVersion(graphVersion) + path,
    {
      method,
      headers: {
        Authorization: "Bearer " + pageAccessToken,
        ...headers,
      },
      ...(body === undefined ? {} : { body }),
    },
  );
  return readGraphJson(response);
}

export async function verifyFacebookPublishingPage({
  pageId,
  pageAccessToken,
  graphVersion = DEFAULT_GRAPH_VERSION,
  fetchImpl = fetch,
} = {}) {
  const id = cleanPageId(pageId);
  if (typeof pageAccessToken !== "string" || !pageAccessToken) {
    throw new FacebookPublishingError("FACEBOOK_RECONNECT_REQUIRED", "Facebook needs to be reconnected before publishing.", { httpStatus: 409 });
  }
  const data = await graphRequest({
    fetchImpl,
    graphVersion,
    path: "/" + encodeURIComponent(id) + "?fields=id,name",
    pageAccessToken,
  });
  if (String(data?.id || "") !== id || typeof data?.name !== "string" || !data.name.trim()) {
    throw new FacebookPublishingError("FACEBOOK_PAGE_MISMATCH", "Facebook returned a different Page than this workspace expected.", { httpStatus: 409 });
  }
  return { pageId: id, pageName: data.name.trim() };
}

export async function publishFacebookPagePost({
  pageId,
  pageAccessToken,
  graphVersion = DEFAULT_GRAPH_VERSION,
  message,
  imageDataUrl = "",
  imageDataUrls = null,
  fetchImpl = fetch,
} = {}) {
  const id = cleanPageId(pageId);
  const text = String(message || "").trim();
  if (!text) {
    throw new FacebookPublishingError("FACEBOOK_MESSAGE_REQUIRED", "Review and enter the Facebook post copy first.", { httpStatus: 400 });
  }
  if (text.length > 5000) {
    throw new FacebookPublishingError("FACEBOOK_MESSAGE_TOO_LONG", "Facebook post copy is too long for this GrowthWise beta.", { httpStatus: 400 });
  }
  const images = normalizeImages({ imageDataUrl, imageDataUrls });

  if (!images.length) {
    const form = new URLSearchParams();
    form.set("message", text);
    const data = await graphRequest({
      fetchImpl,
      graphVersion,
      path: "/" + encodeURIComponent(id) + "/feed",
      pageAccessToken,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    return {
      postType: "text",
      postId: typeof data?.id === "string" ? data.id : null,
      photoCount: 0,
    };
  }

  if (images.length === 1) {
    const form = new FormData();
    form.append("message", text);
    form.append("published", "true");
    form.append(
      "source",
      new Blob([images[0].bytes], { type: images[0].mime }),
      images[0].mime === "image/png" ? "growthwise-post.png" : "growthwise-post.jpg",
    );
    const data = await graphRequest({
      fetchImpl,
      graphVersion,
      path: "/" + encodeURIComponent(id) + "/photos",
      pageAccessToken,
      method: "POST",
      body: form,
    });
    return {
      postType: "photo",
      postId: typeof data?.post_id === "string"
        ? data.post_id
        : typeof data?.id === "string"
          ? data.id
          : null,
      photoCount: 1,
    };
  }

  const mediaIds = [];
  for (let index = 0; index < images.length; index += 1) {
    const form = new FormData();
    form.append("published", "false");
    form.append(
      "source",
      new Blob([images[index].bytes], { type: images[index].mime }),
      "growthwise-post-" + (index + 1) + "." + (images[index].mime === "image/png" ? "png" : "jpg"),
    );
    const uploaded = await graphRequest({
      fetchImpl,
      graphVersion,
      path: "/" + encodeURIComponent(id) + "/photos",
      pageAccessToken,
      method: "POST",
      body: form,
    });
    if (typeof uploaded?.id !== "string" || !uploaded.id) {
      throw new FacebookPublishingError("FACEBOOK_PUBLISH_FAILED", "Facebook could not prepare all selected photos.", { httpStatus: 502 });
    }
    mediaIds.push(uploaded.id);
  }

  const form = new URLSearchParams();
  form.set("message", text);
  mediaIds.forEach((mediaId, index) => {
    form.set("attached_media[" + index + "]", JSON.stringify({ media_fbid: mediaId }));
  });
  const data = await graphRequest({
    fetchImpl,
    graphVersion,
    path: "/" + encodeURIComponent(id) + "/feed",
    pageAccessToken,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  return {
    postType: "multi_photo",
    postId: typeof data?.id === "string" ? data.id : null,
    photoCount: mediaIds.length,
  };
}
