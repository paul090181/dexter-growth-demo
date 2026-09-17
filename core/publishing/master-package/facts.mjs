import { isDeepStrictEqual } from "node:util";

export function compareProtectedFacts(master, candidate, approvedOverrides = []) {
  const changes = [];
  const errors = [];
  const approved = new Set(approvedOverrides);
  const masterFacts = master?.verified_facts ?? {};
  const candidateFacts = candidate?.verified_facts ?? {};

  for (const key of Object.keys(masterFacts)) {
    const before = masterFacts[key];
    const after = candidateFacts[key];
    if (isDeepStrictEqual(before, after)) continue;

    const isApproved = approved.has(key);
    changes.push({ key, from: before, to: after, approved: isApproved });
    if (!isApproved) errors.push(`protected fact ${key} changed without an approved override`);
  }

  return { ok: errors.length === 0, changes, errors };
}
