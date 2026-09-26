const RESEND_ORIGIN = "https://api.resend.com";
const RESEND_ENDPOINT = `${RESEND_ORIGIN}/emails`;
const TIMEOUT_MS = 8_000;

function env(name) {
  return globalThis.Netlify?.env?.get(name) || "";
}

function clean(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function configuredTransactionalEmail() {
  const apiKey = clean(env("GROWTHWISE_TRANSACTIONAL_EMAIL_API_KEY"), 500);
  const from = clean(env("GROWTHWISE_TRANSACTIONAL_EMAIL_FROM"), 320);
  return apiKey && from ? { provider: "resend", apiKey, from } : null;
}

export async function sendTenantMagicLinks({
  config,
  to,
  links,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!config || config.provider !== "resend" || !config.apiKey || !config.from) {
    throw new Error("TRANSACTIONAL_EMAIL_NOT_CONFIGURED");
  }
  const recipient = clean(to, 254).toLowerCase();
  if (!recipient.includes("@") || !Array.isArray(links) || links.length === 0) {
    throw new Error("INVALID_TRANSACTIONAL_EMAIL");
  }

  const safeLinks = links.map((entry) => {
    const businessName = clean(entry?.businessName, 160);
    const url = new URL(String(entry?.url || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || !url.hash.startsWith("#token=gw_login_")) {
      throw new Error("INVALID_MAGIC_LINK");
    }
    return { businessName, url: url.toString() };
  });

  const rows = safeLinks.map(({ businessName, url }) =>
    `<p><strong>${escapeHtml(businessName || "Your business")}</strong><br><a href="${escapeHtml(url)}">Sign in securely</a></p>`
  ).join("");

  let response;
  try {
    response = await fetchImpl(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [recipient],
        subject: "Your secure GrowthWise sign-in link",
        html: `<p>Use the secure link below to open your business workspace. The link expires in 15 minutes and can be used once.</p>${rows}<p>If you did not request this email, you can ignore it.</p>`,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("TRANSACTIONAL_EMAIL_SEND_FAILED");
  }
  if (!response.ok) throw new Error("TRANSACTIONAL_EMAIL_SEND_FAILED");
  return true;
}
