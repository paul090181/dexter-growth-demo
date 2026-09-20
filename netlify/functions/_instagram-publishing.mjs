import { INSTAGRAM_CONTENT_PUBLISH_SCOPE } from "./_instagram-oauth.mjs";

const DEFAULT_GRAPH_VERSION = "v26.0";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;

export class InstagramPublishError extends Error {
  constructor(code, { status = null } = {}) {
    const messages = {
      create_failed: "Instagram could not prepare the post.",
      publish_failed: "Instagram could not publish the post.",
      status_failed: "Instagram could not report the media status.",
      processing_failed: "Instagram could not finish processing the media.",
      processing_timeout: "Instagram is still processing the media.",
      temporarily_unavailable: "Instagram is temporarily unavailable.",
      invalid_response: "Instagram returned an invalid publishing response.",
    };
    if (!Object.hasOwn(messages, code)) throw new TypeError("Invalid Instagram publishing error code.");
    super(messages[code]);
    this.name = "InstagramPublishError";
    this.code = code;
    this.status = Number.isInteger(status) ? status : null;
  }
}

function requireAccountId(value) {
  const id = String(value ?? "");
  if (!/^\d{1,64}$/.test(id)) throw new TypeError("A valid Instagram account ID is required.");
  return id;
}

function requireText(value, label, max = 2200) {
  if (typeof value !== "string" || !value.length || value.length > max) throw new TypeError(`${label} is invalid.`);
  return value;
}

function graphVersion(value) {
  const version = value || DEFAULT_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(version)) throw new TypeError("Invalid Instagram Graph API version.");
  return version;
}

async function readJson(response, failureCode, maxResponseBytes) {
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new InstagramPublishError("temporarily_unavailable", { status: response.status });
    }
    throw new InstagramPublishError(failureCode, { status: response.status });
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxResponseBytes) {
    throw new InstagramPublishError("invalid_response");
  }
  let json;
  try { json = JSON.parse(text); } catch { throw new InstagramPublishError("invalid_response"); }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new InstagramPublishError("invalid_response");
  return json;
}

async function getJson(path, fields, {
  accessToken,
  fetchImpl = fetch,
  graphApiVersion = DEFAULT_GRAPH_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  failureCode,
} = {}) {
  const token = requireText(accessToken, "Instagram access token", 8192);
  const version = graphVersion(graphApiVersion);
  const url = new URL(`https://graph.instagram.com/${version}/${path}`);
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new InstagramPublishError("temporarily_unavailable");
  }
  return readJson(response, failureCode, maxResponseBytes);
}

async function postForm(path, fields, {
  accessToken,
  fetchImpl = fetch,
  graphApiVersion = DEFAULT_GRAPH_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  failureCode,
} = {}) {
  const token = requireText(accessToken, "Instagram access token", 8192);
  const version = graphVersion(graphApiVersion);
  const url = new URL(`https://graph.instagram.com/${version}/${path}`);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new InstagramPublishError("temporarily_unavailable");
  }
  return readJson(response, failureCode, maxResponseBytes);
}

export async function createInstagramImageContainer({
  accountId,
  accessToken,
  imageUrl,
  caption,
  ...options
} = {}) {
  const id = requireAccountId(accountId);
  const image = requireText(imageUrl, "Instagram image URL", 4096);
  const parsedImage = new URL(image);
  if (parsedImage.protocol !== "https:" || parsedImage.username || parsedImage.password || parsedImage.hash) {
    throw new TypeError("Instagram image URL must use HTTPS.");
  }
  const text = requireText(caption, "Instagram caption");
  const json = await postForm(`${id}/media`, { image_url: parsedImage.toString(), caption: text }, {
    ...options,
    accessToken,
    failureCode: "create_failed",
  });
  if (typeof json.id !== "string" || !/^\d+$/.test(json.id)) throw new InstagramPublishError("invalid_response");
  return { containerId: json.id };
}

export async function getInstagramContainerStatus({
  accessToken,
  containerId,
  ...options
} = {}) {
  const id = String(containerId ?? "");
  if (!/^\d+$/.test(id)) throw new TypeError("A valid Instagram container ID is required.");
  const json = await getJson(id, { fields: "status_code,status" }, {
    ...options,
    accessToken,
    failureCode: "status_failed",
  });
  const statusCode = typeof json.status_code === "string" ? json.status_code : "";
  if (!["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED", "PUBLISHED"].includes(statusCode)) {
    throw new InstagramPublishError("invalid_response");
  }
  return {
    statusCode,
    status: typeof json.status === "string" ? json.status : "",
  };
}

export async function waitForInstagramContainerReady({
  accessToken,
  containerId,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  delaysMs = [1000, 2000, 3000, 4000, 5000],
  ...options
} = {}) {
  if (!Array.isArray(delaysMs) || delaysMs.length === 0 || delaysMs.length > 10
    || delaysMs.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 30_000)) {
    throw new TypeError("Invalid Instagram container polling schedule.");
  }

  let lastStatus = "IN_PROGRESS";
  for (const delayMs of delaysMs) {
    if (delayMs > 0) await sleepImpl(delayMs);
    const result = await getInstagramContainerStatus({
      accessToken,
      containerId,
      ...options,
    });
    lastStatus = result.statusCode;
    if (lastStatus === "FINISHED") return result;
    if (lastStatus === "PUBLISHED") return result;
    if (lastStatus === "ERROR" || lastStatus === "EXPIRED") {
      throw new InstagramPublishError("processing_failed");
    }
  }
  throw new InstagramPublishError("processing_timeout");
}

export async function publishInstagramContainer({
  accountId,
  accessToken,
  containerId,
  ...options
} = {}) {
  const id = requireAccountId(accountId);
  const creationId = String(containerId ?? "");
  if (!/^\d+$/.test(creationId)) throw new TypeError("A valid Instagram container ID is required.");
  const json = await postForm(`${id}/media_publish`, { creation_id: creationId }, {
    ...options,
    accessToken,
    failureCode: "publish_failed",
  });
  if (typeof json.id !== "string" || !/^\d+$/.test(json.id)) throw new InstagramPublishError("invalid_response");
  return { mediaId: json.id };
}
