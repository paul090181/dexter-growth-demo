import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const signup = await readFile(new URL("../../signup.html", import.meta.url), "utf8");
const help = await readFile(new URL("../../business-email-help.html", import.meta.url), "utf8");

test("signup gives a clear just-in-time business-mailbox privacy recommendation", () => {
  assert.match(signup, /Use a business mailbox when possible\./);
  assert.match(signup, /If you connect a personal mailbox, GrowthWise may be able to access personal messages/i);
  assert.match(signup, /business-email-help\.html/);
});

test("business email help offers a separate free Microsoft mailbox and a custom-domain option", () => {
  assert.match(help, /Create a separate Outlook\.com address/);
  assert.match(help, /https:\/\/outlook\.com\//);
  assert.match(help, /sales@yourbusiness\.com/);
  assert.match(help, /microsoft\.com\/en-us\/microsoft-365\/outlook\/outlook-business-email-plans/);
});

test("business email guidance does not encourage sharing credentials", () => {
  assert.match(help, /GrowthWise does not receive or store your Microsoft password\./);
  assert.match(help, /Avoid connecting the same inbox you use for family, banking, healthcare, or other personal messages\./);
  assert.match(help, /Start with read-only access/);
  assert.match(help, /Enable sending or automated replies only when you are comfortable/);
});

test("external email-setup links do not leak referrers or opener access", () => {
  assert.match(help, /Referrer-Policy/);
  assert.match(help, /target="_blank" rel="noopener noreferrer"/);
});
