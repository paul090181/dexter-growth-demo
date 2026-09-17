import { AUTOMATION_LEVELS } from "../constants.mjs";

const isAutomationLevel = (value) => AUTOMATION_LEVELS.includes(value);

/**
 * Resolve a client's automation level using the most-specific configured rule.
 * Invalid or absent configuration fails closed to manual operation.
 */
export function resolveAutomationLevel(config, channelId, action) {
  const automation = config?.publishing?.automation;
  if (!automation || typeof automation !== "object") return "manual";

  const candidates = [
    automation.actions?.[action],
    automation.channels?.[channelId],
    automation.default,
  ];

  return candidates.find(isAutomationLevel) ?? "manual";
}
