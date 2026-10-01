import test from "node:test";
import assert from "node:assert/strict";

import { createInstagramCrypto } from "../../netlify/functions/_instagram-crypto.mjs";

const key32 = (byte) => Buffer.alloc(32, byte).toString("base64url");
const configuration = (overrides = {}) => ({
  stateSecrets: { current: { id: "state-1", key: "synthetic-state-secret-for-tests" } },
  bindingSecrets: { current: { id: "binding-1", key: "synthetic-binding-secret-for-tests" } },
  credentialKeys: { current: { id: "credential-1", key: key32(7) } },
  ...overrides,
});

test("createState uses a fresh 256-bit nonce and exposes no business claim", () => {
  const nonces = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  const crypto = createInstagramCrypto(configuration({ randomBytesImpl: (size) => {
    assert.equal(size, 32);
    return nonces.shift();
  } }));
  const first = crypto.createState();
  const second = crypto.createState();
  assert.match(first.state, /^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.state, second.state);
  assert.equal(first.keyVersion, "state-1");
  assert.equal(first.nonceHash, crypto.transactionKey(first.state));
  assert.doesNotMatch(first.state, /business|tenant/i);
});

test("verifyState rejects malformed state and a bad HMAC in constant-time comparison path", () => {
  const crypto = createInstagramCrypto(configuration());
  for (const value of ["", "v1.only", "v2.a.b", "v1.***.***", "v1.YQ.YQ"])
    assert.throws(() => crypto.verifyState(value), /INVALID_STATE/);
  const { state } = crypto.createState();
  const [version, nonce, tag] = state.split(".");
  const changed = `${version}.${nonce}.${tag.slice(0, -1)}${tag.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => crypto.verifyState(changed), /INVALID_STATE/);
});

test("account binding HMAC uses only the dedicated binding secret", () => {
  const base = configuration();
  const first = createInstagramCrypto(base).accountBindingKey("ig-account-42");
  const changedState = createInstagramCrypto({ ...base, stateSecrets: { current: { id: "state-2", key: "another-state-secret-for-tests" } } }).accountBindingKey("ig-account-42");
  const changedBinding = createInstagramCrypto({ ...base, bindingSecrets: { current: { id: "binding-2", key: "another-binding-secret-for-tests" } } }).accountBindingKey("ig-account-42");
  assert.equal(first, changedState);
  assert.notEqual(first, changedBinding);
  assert.doesNotMatch(first, /ig-account-42/);
  const boundaryId = "b".repeat(64);
  const boundaryCrypto = createInstagramCrypto({
    ...base,
    bindingSecrets: { current: { id: boundaryId, key: "boundary-binding-secret-for-tests" } },
  });
  assert.match(boundaryCrypto.accountBindingKey("ig-account-42"), new RegExp(`^${boundaryId}\\.`));
  assert.throws(() => createInstagramCrypto({
    ...base,
    bindingSecrets: { current: { id: "b".repeat(65), key: "unsafe-binding-secret-for-tests" } },
  }), /INVALID_BINDING_CONFIGURATION/);
});

test("OAuth state-secret rotation does not change the account-binding key", () => {
  const base = configuration();
  const rotated = configuration({ stateSecrets: { current: { id: "state-2", key: "rotated-state-secret-for-tests" }, previous: [base.stateSecrets.current] } });
  assert.equal(createInstagramCrypto(base).accountBindingKey("account-7"), createInstagramCrypto(rotated).accountBindingKey("account-7"));
});

test("credential encryption round trip requires matching tenant and account AAD", () => {
  const crypto = createInstagramCrypto(configuration());
  const payload = { access_token: "SYNTHETIC_ACCESS_TOKEN_DO_NOT_USE", instagram_user_id: "123" };
  const encryptedToken = crypto.encryptCredential({ businessId: "tenant-a", accountId: "123", payload });
  assert.deepEqual(crypto.decryptCredential({ businessId: "tenant-a", accountId: "123", encryptedToken }), payload);
  assert.throws(() => crypto.decryptCredential({ businessId: "tenant-b", accountId: "123", encryptedToken }), /CREDENTIAL_DECRYPT_FAILED/);
  assert.throws(() => crypto.decryptCredential({ businessId: "tenant-a", accountId: "124", encryptedToken }), /CREDENTIAL_DECRYPT_FAILED/);
  assert.doesNotMatch(JSON.stringify(encryptedToken), /SYNTHETIC_ACCESS_TOKEN_DO_NOT_USE|123/);
});

test("credential encryption uses a fresh 96-bit IV for every write", () => {
  const crypto = createInstagramCrypto(configuration());
  const input = { businessId: "tenant-a", accountId: "123", payload: { access_token: "SYNTHETIC_TOKEN" } };
  const first = crypto.encryptCredential(input);
  const second = crypto.encryptCredential(input);
  assert.equal(Buffer.from(first.iv, "base64url").length, 12);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("modified ciphertext or authentication tag fails closed", () => {
  const crypto = createInstagramCrypto(configuration());
  const sentinel = "SYNTHETIC_TOKEN";
  const input = { businessId: "tenant-a", accountId: "123", payload: { access_token: sentinel } };
  const envelope = crypto.encryptCredential(input);
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  assert.ok(ciphertext.length > 16, "envelope contains a ciphertext body before the 16-byte tag");

  for (const index of [0, ciphertext.length - 1]) {
    const modified = Buffer.from(ciphertext);
    modified[index] ^= 1;
    assert.throws(
      () => crypto.decryptCredential({
        ...input,
        encryptedToken: { ...envelope, ciphertext: modified.toString("base64url") },
      }),
      (error) => {
        assert.equal(error.message, "CREDENTIAL_DECRYPT_FAILED");
        assert.doesNotMatch(error.message, new RegExp(sentinel, "i"));
        return true;
      },
    );
  }
});

test("unknown credential key version fails closed without key material in the error", () => {
  const crypto = createInstagramCrypto(configuration());
  const input = { businessId: "tenant-a", accountId: "123", payload: { access_token: "SYNTHETIC_TOKEN" } };
  const encryptedToken = { ...crypto.encryptCredential(input), key_version: "unrecognized-version" };
  assert.throws(() => crypto.decryptCredential({ ...input, encryptedToken }), (error) => {
    assert.match(error.message, /UNKNOWN_CREDENTIAL_KEY/);
    assert.doesNotMatch(error.message, /synthetic|tenant|123|unrecognized-version/i);
    return true;
  });
});
