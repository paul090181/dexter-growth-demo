async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

export const WEBSITE_FORM_ID_PATTERN = /^gwf_[A-Za-z0-9_-]{22}$/;

function failure(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function businessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) || clean.length > 80) {
    throw failure("INVALID_BUSINESS_ID");
  }
  return clean;
}

function formId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!WEBSITE_FORM_ID_PATTERN.test(clean)) throw failure("INVALID_FORM_ID");
  return clean;
}

function date(value, code) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw failure(code);
  return parsed;
}

function safeRow(row) {
  if (!row) return null;
  return {
    business_id: row.business_id,
    form_id: row.form_id,
    disabled_at: row.disabled_at ? new Date(row.disabled_at) : null,
    created_at: row.created_at ? new Date(row.created_at) : null,
    updated_at: row.updated_at ? new Date(row.updated_at) : null,
  };
}

export function createWebsiteFormStore({ getPool = netlifyPool } = {}) {
  async function readByBusiness(input = {}) {
    const id = businessId(input.businessId);
    try {
      const result = await (await getPool()).query(
        `SELECT business_id, form_id, disabled_at, created_at, updated_at
           FROM growthwise_website_forms
          WHERE business_id = $1
          LIMIT 1`,
        [id],
      );
      return safeRow(result.rows[0]);
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw failure("WEBSITE_FORM_READ_FAILED", error);
    }
  }

  async function readEnabledByFormId(input = {}) {
    const id = formId(input.formId);
    try {
      const result = await (await getPool()).query(
        `SELECT business_id, form_id, disabled_at, created_at, updated_at
           FROM growthwise_website_forms
          WHERE form_id = $1
            AND disabled_at IS NULL
          LIMIT 1`,
        [id],
      );
      return safeRow(result.rows[0]);
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw failure("WEBSITE_FORM_READ_FAILED", error);
    }
  }

  async function ensureEnabled(input = {}) {
    const id = businessId(input.businessId);
    const nextFormId = formId(input.formId);
    const changedAt = date(input.now ?? new Date(), "INVALID_FORM_TIME");
    try {
      const result = await (await getPool()).query(
        `INSERT INTO growthwise_website_forms
           (business_id, form_id, disabled_at, created_at, updated_at)
         VALUES ($1, $2, NULL, $3, $3)
         ON CONFLICT (business_id) DO UPDATE SET
           disabled_at = NULL,
           updated_at = EXCLUDED.updated_at
         RETURNING business_id, form_id, disabled_at, created_at, updated_at`,
        [id, nextFormId, changedAt],
      );
      return safeRow(result.rows[0]);
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw failure("WEBSITE_FORM_ENABLE_FAILED", error);
    }
  }

  async function disable(input = {}) {
    const id = businessId(input.businessId);
    const changedAt = date(input.now ?? new Date(), "INVALID_FORM_TIME");
    try {
      const result = await (await getPool()).query(
        `UPDATE growthwise_website_forms
            SET disabled_at = $2,
                updated_at = $2
          WHERE business_id = $1
            AND disabled_at IS NULL
        RETURNING business_id, form_id, disabled_at, created_at, updated_at`,
        [id, changedAt],
      );
      return safeRow(result.rows[0]);
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw failure("WEBSITE_FORM_DISABLE_FAILED", error);
    }
  }

  return { readByBusiness, readEnabledByFormId, ensureEnabled, disable };
}
