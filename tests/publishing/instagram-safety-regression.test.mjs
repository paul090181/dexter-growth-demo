import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (file) => readFile(path.join(ROOT, file), "utf8");

async function filesUnder(directory, accept = () => true) {
  const entries = await readdir(path.join(ROOT, directory), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const relative = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(relative, accept) : (accept(relative) ? [relative] : []);
  }));
  return nested.flat();
}

async function joined(files) {
  return (await Promise.all(files.map(read))).join("\n");
}

const runtimeFiles = async () => [
  ...await filesUnder("netlify/functions", (file) => file.endsWith(".mjs")),
  ...await filesUnder("core", (file) => file.endsWith(".mjs")),
  ...await filesUnder("integrations", (file) => file.endsWith(".mjs")),
];

test("Instagram publishing permission is limited to the OAuth configuration", async () => {
  const files = [...await runtimeFiles(), ...await filesUnder("clients", (file) => file.endsWith(".json"))];
  const containing = [];
  for (const file of files) {
    if ((await read(file)).includes("instagram_business_content_publish")) containing.push(file);
  }
  assert.deepEqual(containing.sort(), [
    "netlify/functions/_instagram-oauth.mjs",
  ]);
});

test("Instagram live endpoints exist only in the explicit publishing provider and no webhooks or messaging were added", async () => {
  const files = await runtimeFiles();
  const liveEndpointFiles = [];
  for (const file of files) {
    const source = await read(file);
    if (/media_publish|\/${?id}?\/media|\/media\b/.test(source)) liveEndpointFiles.push(file);
  }
  assert.deepEqual(liveEndpointFiles.sort(), [
    "netlify/functions/_instagram-publishing.mjs",
    "netlify/functions/instagram-publish.mjs",
  ]);
  const source = await joined(files);
  const assembled = source.replace(/[\s"'\`+]/g, "");
  assert.doesNotMatch(source, /\b(?:InstagramWebhook|registerWebhook|subscribeWebhook|instagram_business_manage_messages|instagram_business_manage_comments)\b/i);
  assert.doesNotMatch(assembled, /instagram.{0,160}webhooks?|webhooks?.{0,160}instagram/i);
});

test("Instagram publish handler requires explicit reviewed confirmation before staging or provider calls", async () => {
  const source = await read("netlify/functions/instagram-publish.mjs");
  assert.match(source, /body\.reviewed\s*!==\s*true/);
  assert.match(source, /Review and confirmation are required before publishing/);
  assert.doesNotMatch(await joined(await filesUnder("core/publishing", (file) => file.endsWith(".mjs"))), /instagram-publish|media_publish/);
});

test("Publishing Core source preserves live_sent false invariant", async () => {
  const files = [
    ...await filesUnder("core/publishing", (file) => file.endsWith(".mjs")),
    ...await filesUnder("integrations/channels", (file) => file.endsWith(".mjs")),
    "netlify/functions/publishing-shadow.mjs",
  ];
  const source = await joined(files);
  const assignments = [...source.matchAll(/live_sent\s*:\s*([^,}\n]+)/g)].map((match) => match[1].trim());
  assert.ok(assignments.length > 0, "Publishing Core must expose the live_sent invariant");
  assert.deepEqual([...new Set(assignments)], ["false"]);
});

test("protected Auto City Square and Facebook files match branch baseline", async () => {
  const expected = new Map([
    ["automotive-pilot.html", "8fe5fbb86a3288cb7a6efdb73974dc93d34b9ea871f91dcd2ec590ada60578de"],
    ["netlify/functions/facebook-post.mjs", "063848eb729d99fec036a76ee5a1606712f6946e6383cdb4be092a152908d664"],
    ["netlify/functions/add-product.mjs", "6ea871479eb179f85468f55765b60da381ad0bf34b38ddfbb65595913ec3101c"],
  ]);
  for (const [file, digest] of expected) {
    const actual = createHash("sha256").update(await read(file)).digest("hex");
    assert.equal(actual, digest, `${file} differs from the approved platform-v1 baseline`);
  }
});

test("frontend assets contain no server environment secret names except the admin header name", async () => {
  const files = [
    ...await filesUnder("assets", (file) => /\.(?:mjs|js|html)$/.test(file)),
    "index.html",
    "instagram-dev.html",
  ];
  const source = await joined(files);
  assert.doesNotMatch(source, /GROWTHWISE_(?:INSTAGRAM_(?:APP_SECRET|OAUTH_STATE_SECRET|ACCOUNT_BINDING_SECRET|CREDENTIAL_ENCRYPTION_KEY)|ADMIN_KEY)|NETLIFY_DB_URL/);
});

test("development harness contains no growth.wise1 allowlist account ID token or provider credential", async () => {
  const source = await read("instagram-dev.html");
  assert.doesNotMatch(source, /growth\.wise1|access[_-]?token|account[_-]?id|app[_-]?secret|provider[_-]?credential/i);
});

test("temporary database acceptance harness is removed from the development UI", async () => {
  const source = await read("instagram-dev.html");
  assert.doesNotMatch(source, /TEMPORARY ACCEPTANCE HARNESS|instagram-database-acceptance|Run database acceptance/);
});

test("development and Dexter pages import the same connection component once", async () => {
  for (const file of ["instagram-dev.html", "index.html"]) {
    const matches = (await read(file)).match(/(?:\.\/)?assets\/instagram-connection\.mjs/g) ?? [];
    assert.equal(matches.length, 1, `${file} must import the shared component exactly once`);
  }
});

test("client JSON contains no token code secret or credential values", async () => {
  for (const file of await filesUnder("clients", (candidate) => candidate.endsWith(".json"))) {
    const document = JSON.parse(await read(file));
    const inspect = (value, key = "") => {
      if (Array.isArray(value)) return value.forEach((item) => inspect(item, key));
      if (value && typeof value === "object") return Object.entries(value).forEach(([childKey, child]) => inspect(child, childKey));
      const environmentReference = /_env$/i.test(key);
      if (environmentReference) {
        assert.match(String(value), /^[A-Z][A-Z0-9_]+$/, `${file} environment reference must be a name, not a value`);
      } else {
        assert.doesNotMatch(key, /(?:access|refresh)?_?token|authorization_?code|client_?secret|app_?secret|password|private_?key|credential|ciphertext/i, `${file} contains a secret-bearing field`);
        assert.doesNotMatch(String(value), /^(?:Bearer\s+|IG[A-Za-z0-9_-]{20,}|EAA[A-Za-z0-9_-]{20,})/i, `${file} contains a suspicious credential literal`);
      }
    };
    inspect(document);
  }
});

test("runtime client and frontend source contain no sentinel secrets or literal secret assignments", async () => {
  const files = [
    ...await runtimeFiles(),
    ...await filesUnder("assets", (file) => file.endsWith(".mjs")),
    "index.html",
    "instagram-dev.html",
  ];
  const source = await joined(files);
  assert.doesNotMatch(source, /SENTINEL_(?:ADMIN_KEY|APP_SECRET|TOKEN)_DO_NOT_LEAK|SENTINEL_PROVIDER_RAW|SENTINEL_(?:SHORT|LONG)_TOKEN/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)\s*\([^)]*(?:accessToken|access_token|appSecret|authorizationCode)/s);
  assert.doesNotMatch(source, /\b(?:access_?token|refresh_?token|app_?secret|client_?secret|encryption_?key|state_?secret|binding_?secret)\b\s*[:=]\s*["'][^"']+["']/i);
});
