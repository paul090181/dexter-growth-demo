const ACTIONS_BY_ROLE = Object.freeze({
  owner_admin: Object.freeze([
    "draft:create",
    "draft:edit",
    "draft:approve",
    "publish:request",
    "publish:auto",
    "settings:automation",
    "settings:integrations",
    "analytics:view",
  ]),
  manager: Object.freeze([
    "draft:create",
    "draft:edit",
    "draft:approve",
    "publish:request",
    "publish:auto",
    "analytics:view",
  ]),
  staff: Object.freeze([
    "draft:create",
    "draft:edit",
    "publish:request",
    "analytics:view",
  ]),
  view_only: Object.freeze(["analytics:view"]),
});

export function authorizeRole(role, action) {
  const allowed = ACTIONS_BY_ROLE[role]?.includes(action) ?? false;
  return {
    allowed,
    reason: allowed
      ? `${role} is authorized for ${action}`
      : `${role || "unknown role"} is not authorized for ${action || "unknown action"}`,
  };
}
