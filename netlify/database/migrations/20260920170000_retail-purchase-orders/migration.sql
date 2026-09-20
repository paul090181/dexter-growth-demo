CREATE TABLE retail_purchase_orders (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  po_number TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  vendor_contact TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','ordered','confirmed','shipped','received','cancelled')),
  ordered_at TIMESTAMPTZ,
  expected_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ,
  carrier TEXT,
  tracking_number TEXT,
  notes TEXT,
  subtotal_cents BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  shipping_cents BIGINT NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  tax_cents BIGINT NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, po_number)
);

CREATE TABLE retail_purchase_order_lines (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES retail_purchase_orders(id) ON DELETE CASCADE,
  square_item_id TEXT,
  square_variation_id TEXT,
  item_name TEXT NOT NULL,
  variation_name TEXT,
  sku TEXT,
  upc TEXT,
  vendor_sku TEXT,
  quantity_ordered INTEGER NOT NULL CHECK (quantity_ordered > 0),
  quantity_received INTEGER NOT NULL DEFAULT 0 CHECK (quantity_received >= 0),
  unit_cost_cents BIGINT NOT NULL CHECK (unit_cost_cents >= 0),
  retail_price_cents BIGINT CHECK (retail_price_cents IS NULL OR retail_price_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX retail_purchase_orders_business_status_idx
  ON retail_purchase_orders (business_id, status, created_at DESC);

CREATE INDEX retail_purchase_order_lines_order_idx
  ON retail_purchase_order_lines (purchase_order_id);

CREATE INDEX retail_purchase_order_lines_square_variation_idx
  ON retail_purchase_order_lines (square_variation_id);
