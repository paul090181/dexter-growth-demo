import { createMicrosoftMailCrypto } from "./_microsoft-mail-crypto.mjs";
import { createMicrosoftMailStore } from "./_microsoft-mail-store.mjs";
import { getMicrosoftMailAccess } from "./_microsoft-mail-access.mjs";
import { MicrosoftMailGraphError } from "./_microsoft-mail-graph.mjs";
import { configuredMicrosoftMailOAuth } from "./_microsoft-mail-oauth.mjs";
import {
  createAndStoreMicrosoftMailSubscription,
  microsoftMailRenewBefore,
  renewMicrosoftMailSubscriptionRecord,
} from "./_microsoft-mail-subscriptions.mjs";

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createMicrosoftMailCrypto({
    stateSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export async function renewDueMicrosoftMailSubscriptions({
  now = new Date(),
  crypto = defaultCrypto(),
  store = createMicrosoftMailStore({ crypto }),
  access = getMicrosoftMailAccess,
  renewRecord = renewMicrosoftMailSubscriptionRecord,
  recreate = createAndStoreMicrosoftMailSubscription,
  config = configuredMicrosoftMailOAuth(),
  logger = console,
} = {}) {
  const rows = await store.listSubscriptionsExpiringBefore({
    before: microsoftMailRenewBefore(now),
  });

  const result = {
    checked: rows.length,
    renewed: 0,
    recreated: 0,
    attention: 0,
  };

  for (const subscription of rows) {
    try {
      const auth = await access({
        businessId: subscription.business_id,
        now,
        crypto,
        store,
        config,
      });

      try {
        await renewRecord({
          subscription,
          accessToken: auth.accessToken,
          store,
          now,
        });
        result.renewed += 1;
      } catch (error) {
        if (error instanceof MicrosoftMailGraphError && [404, 410].includes(error.httpStatus)) {
          await recreate({
            businessId: subscription.business_id,
            accessToken: auth.accessToken,
            publicOrigin: config.publicOrigin,
            store,
            now,
          });
          result.recreated += 1;
        } else {
          throw error;
        }
      }
    } catch {
      result.attention += 1;
      try {
        await store.markSubscriptionStatus({
          businessId: subscription.business_id,
          status: "needs_attention",
        });
      } catch {}
      try {
        await store.markCredentialStatus({
          businessId: subscription.business_id,
          status: "needs_attention",
        });
      } catch {}
      try {
        logger.warn("microsoft_mail_subscription_renewal_failed", {
          business_id: subscription.business_id,
        });
      } catch {}
    }
  }

  return result;
}

export default async function microsoftMailRenewSubscriptions() {
  await renewDueMicrosoftMailSubscriptions();
}

export const config = {
  schedule: "0 */12 * * *",
};
