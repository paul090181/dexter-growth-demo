import test from "node:test";
import assert from "node:assert/strict";
import { listChannels, getChannel } from "../../core/publishing/channels/registry.mjs";

test("registry exposes all eleven first-class channels", () => {
  const channels = listChannels();
  assert.equal(channels.length, 11);
  assert.equal(new Set(channels.map((c) => c.id)).size, 11);
  assert.equal(getChannel("facebook-page").deliveryMode, "direct");
  assert.equal(getChannel("facebook-marketplace").deliveryMode, "assisted");
  assert.notDeepEqual(getChannel("facebook-page"), getChannel("facebook-marketplace"));
  for (const channel of channels) {
    assert.ok(channel.id);
    assert.ok(channel.displayName);
    assert.ok(["direct", "assisted", "export"].includes(channel.deliveryMode));
    assert.ok(channel.implementationStatus);
    assert.ok(channel.capabilities && typeof channel.capabilities === "object");
    assert.equal(typeof channel.automaticActionsAllowed, "boolean");
  }
});
