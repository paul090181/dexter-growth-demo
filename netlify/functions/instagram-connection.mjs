import growthwiseDev from "../../clients/growthwise-dev.json" with { type: "json" };
import dextersHats from "../../clients/dexters-hats.json" with { type: "json" };

const GRAPH_VERSION = "v26.0";
const DEFAULT_CLIENTS = Object.freeze({
  [growthwiseDev.business_id]: growthwiseDev,
  [dextersHats.business_id]: dextersHats,
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function configuredAdminKey() {
  return globalThis.Netlify?.env?.get("GROWTHWISE_ADMIN_KEY") ?? "";
}

function configuredEnv(name) {
  return globalThis.Netlify?.env?.get(name);
}

function statusBody(businessId, state, checkedAt, extra = {}) {
  return { business_id: businessId, state, checked_at: checkedAt, ...extra };
}

export function createInstagramConnectionHandler({
  adminKey = configuredAdminKey,
  clients = DEFAULT_CLIENTS,
  env = configuredEnv,
  fetchImpl = fetch,
  now = () => new Date(),
} = {}) {
  return async function instagramConnectionHandler(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed" });
    if (!adminKey() || request.headers.get("x-growthwise-key") !== adminKey()) {
      return json(401, { error: "Invalid GrowthWise access code." });
    }

    const businessId = new URL(request.url).searchParams.get("business_id")?.trim();
    const client = clients[businessId];
    if (!businessId || !client || client.business_id !== businessId) {
      return json(404, { error: "Instagram connection was not found." });
    }

    const checkedAt = now().toISOString();
    const credentialReference = client.integrations?.instagram?.token_env;
    const accountReference = client.integrations?.instagram?.account_id_env;
    const accessToken = credentialReference ? env(credentialReference) : undefined;
    if (!accessToken) {
      return json(200, statusBody(businessId, "Not Connected", checkedAt, {
        action: "An owner must complete the secure Meta authorization flow.",
      }));
    }
    const expectedAccountId = accountReference ? env(accountReference) : undefined;
    if (!expectedAccountId) {
      return json(200, statusBody(businessId, "Needs Attention", checkedAt, {
        action: "Reconnect Instagram so GrowthWise can securely bind the professional account to this business.",
      }));
    }

    try {
      const fields = "user_id,username,name";
      const response = await fetchImpl(`https://graph.instagram.com/${GRAPH_VERSION}/me?fields=${encodeURIComponent(fields)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const graph = await response.json().catch(() => ({}));
      if (!response.ok) {
        return json(200, statusBody(businessId, "Needs Attention", checkedAt, {
          action: "Reconnect Meta. The authorization may be expired or missing required permissions.",
        }));
      }
      const isSingleAccount = graph && typeof graph === "object" && !Array.isArray(graph) && !Array.isArray(graph.data);
      const isExpectedAccount = String(graph?.user_id ?? "") === String(expectedAccountId);
      if (!isSingleAccount || !isExpectedAccount || !graph?.username) {
        return json(200, statusBody(businessId, "Needs Attention", checkedAt, {
          action: "Reconnect the intended Instagram professional account for this GrowthWise business.",
        }));
      }
      return json(200, statusBody(businessId, "Connected", checkedAt, {
        account: { username: graph.username, name: graph.name || graph.username },
      }));
    } catch {
      return json(200, statusBody(businessId, "Needs Attention", checkedAt, {
        action: "GrowthWise could not verify Meta right now. Try the connection check again.",
      }));
    }
  };
}

export default createInstagramConnectionHandler();
