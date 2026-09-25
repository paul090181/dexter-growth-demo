import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createRetailOrdersStore } from "./_retail-orders-store.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cleanAscii(value = "") {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/[^ -~]/g, "?")
    .trim();
}

function dollarsFromCents(value) {
  return (Number(value || 0) / 100).toFixed(2);
}

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function wrapText(text, font, size, maxWidth) {
  const words = cleanAscii(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      line = word;
      continue;
    }

    let chunk = "";
    for (const ch of word) {
      const next = chunk + ch;
      if (font.widthOfTextAtSize(next, size) <= maxWidth) chunk = next;
      else {
        if (chunk) lines.push(chunk);
        chunk = ch;
      }
    }
    line = chunk;
  }

  if (line) lines.push(line);
  return lines;
}

function filenameSafe(value) {
  return cleanAscii(value || "purchase-order")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "purchase-order";
}

export function createRetailOrderPdfHandler(options = {}) {
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name));
  const store = options.store ?? createRetailOrdersStore();

  return async function handler(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });

    const adminKey = env("GROWTHWISE_ADMIN_KEY");
    if (!adminKey) return json(500, { error: "Server configuration is incomplete." });
    if ((request.headers.get("x-growthwise-key") || "") !== adminKey) {
      return json(401, { error: "Invalid GrowthWise access key." });
    }

    const url = new URL(request.url);
    const businessId = String(url.searchParams.get("business_id") || "dexters-hats").trim();
    const orderId = String(url.searchParams.get("order_id") || "").trim();
    if (!businessId || !orderId) return json(400, { error: "Order is required." });

    let order;
    try {
      order = await store.getOrder({ businessId, id: orderId });
    } catch (error) {
      console.error("retail_order_pdf_lookup_failed", { code: error?.message || "UNKNOWN" });
      return json(500, { error: "GrowthWise could not load that purchase order." });
    }

    if (!order) return json(404, { error: "Purchase order was not found." });

    const pdf = await PDFDocument.create();
    pdf.setTitle(`Purchase Order ${cleanAscii(order.po_number)}`);
    pdf.setAuthor("GrowthWise");
    pdf.setSubject("Retail purchase order");
    pdf.setProducer("GrowthWise");

    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const PAGE_W = 612;
    const PAGE_H = 792;
    const MARGIN = 46;
    const CONTENT_W = PAGE_W - MARGIN * 2;
    const dark = rgb(0.055, 0.106, 0.169);
    const gold = rgb(0.55, 0.40, 0.12);
    const gray = rgb(0.38, 0.43, 0.47);
    const light = rgb(0.93, 0.95, 0.96);

    let page;
    let y;

    function addPage() {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      page.drawText("GrowthWise", { x: MARGIN, y, size: 10, font: bold, color: gold });
      page.drawText("Dexter's Hats & Caps", { x: PAGE_W - MARGIN - 130, y, size: 10, font: bold, color: dark });
      y -= 22;
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: PAGE_W - MARGIN, y },
        thickness: 1,
        color: light,
      });
      y -= 18;
    }

    function ensureSpace(height = 40) {
      if (y - height < MARGIN + 26) addPage();
    }

    function drawText(text, {
      x = MARGIN,
      size = 10,
      font = regular,
      color = dark,
      maxWidth = CONTENT_W,
      lineHeight = size + 3,
    } = {}) {
      const lines = wrapText(text, font, size, maxWidth);
      for (const line of lines) {
        ensureSpace(lineHeight);
        page.drawText(line, { x, y, size, font, color });
        y -= lineHeight;
      }
      return lines.length * lineHeight;
    }

    function labelValue(label, value) {
      const left = cleanAscii(label);
      const right = cleanAscii(value || "-");
      ensureSpace(18);
      page.drawText(left, { x: MARGIN, y, size: 9, font: bold, color: gray });
      page.drawText(right, { x: MARGIN + 112, y, size: 9, font: regular, color: dark });
      y -= 16;
    }

    addPage();

    page.drawText("PURCHASE ORDER", { x: MARGIN, y, size: 23, font: bold, color: dark });
    y -= 30;

    labelValue("PO Number", order.po_number);
    labelValue("Status", String(order.status || "").toUpperCase());
    labelValue("Vendor", order.vendor_name);
    if (order.vendor_contact) labelValue("Vendor Contact", order.vendor_contact);
    labelValue("Created", formatDate(order.created_at));
    if (order.ordered_at) labelValue("Ordered", formatDate(order.ordered_at));
    if (order.expected_at) labelValue("Expected", formatDate(order.expected_at));
    if (order.received_at) labelValue("Received", formatDate(order.received_at));
    if (order.tracking_number) {
      labelValue("Shipment", [order.carrier, order.tracking_number].filter(Boolean).join(" - "));
    }

    y -= 8;
    ensureSpace(42);
    page.drawText("ITEMS", { x: MARGIN, y, size: 10, font: bold, color: gold });
    y -= 17;

    const headers = [
      ["Item", MARGIN, 220],
      ["Qty", MARGIN + 228, 35],
      ["Cost", MARGIN + 273, 68],
      ["Line Total", MARGIN + 351, 90],
    ];
    page.drawRectangle({ x: MARGIN, y: y - 6, width: CONTENT_W, height: 22, color: light });
    for (const [text, x] of headers) {
      page.drawText(text, { x: x + 4, y: y + 1, size: 8, font: bold, color: dark });
    }
    y -= 20;

    for (const line of order.lines || []) {
      const quantity = Number(line.quantity_ordered || 0);
      const lineTotalCents = quantity * Number(line.unit_cost_cents || 0);
      const details = [
        line.variation_name && line.variation_name !== "Default" ? line.variation_name : "",
        line.sku ? `SKU ${line.sku}` : "",
        line.upc ? `UPC ${line.upc}` : "",
        line.vendor_sku ? `Vendor SKU ${line.vendor_sku}` : "",
      ].filter(Boolean).join(" | ");

      const itemLines = wrapText(line.item_name || "Item", bold, 9, 215);
      const detailLines = details ? wrapText(details, regular, 7.5, 215) : [];
      const rowHeight = Math.max(27, itemLines.length * 11 + detailLines.length * 9 + 8);
      ensureSpace(rowHeight + 8);

      let rowY = y;
      for (const itemLine of itemLines) {
        page.drawText(itemLine, { x: MARGIN + 4, y: rowY, size: 9, font: bold, color: dark });
        rowY -= 11;
      }
      for (const detailLine of detailLines) {
        page.drawText(detailLine, { x: MARGIN + 4, y: rowY, size: 7.5, font: regular, color: gray });
        rowY -= 9;
      }

      page.drawText(String(quantity), { x: MARGIN + 232, y, size: 9, font: regular, color: dark });
      page.drawText(`$${dollarsFromCents(line.unit_cost_cents)}`, { x: MARGIN + 277, y, size: 9, font: regular, color: dark });
      page.drawText(`$${dollarsFromCents(lineTotalCents)}`, { x: MARGIN + 355, y, size: 9, font: bold, color: dark });

      y -= rowHeight;
      page.drawLine({
        start: { x: MARGIN, y: y + 4 },
        end: { x: PAGE_W - MARGIN, y: y + 4 },
        thickness: 0.5,
        color: light,
      });
    }

    y -= 10;
    const totals = [
      ["Subtotal", order.subtotal_cents],
      ["Shipping", order.shipping_cents],
      ["Tax / fees", order.tax_cents],
    ];
    for (const [label, value] of totals) {
      ensureSpace(16);
      page.drawText(label, { x: MARGIN + 330, y, size: 9, font: regular, color: gray });
      page.drawText(`$${dollarsFromCents(value)}`, { x: MARGIN + 430, y, size: 9, font: regular, color: dark });
      y -= 15;
    }
    ensureSpace(24);
    page.drawText("TOTAL", { x: MARGIN + 330, y, size: 11, font: bold, color: dark });
    page.drawText(`$${dollarsFromCents(order.total_cents)}`, { x: MARGIN + 430, y, size: 11, font: bold, color: dark });
    y -= 26;

    if (order.notes) {
      ensureSpace(50);
      page.drawText("NOTES", { x: MARGIN, y, size: 10, font: bold, color: gold });
      y -= 16;
      drawText(order.notes, { size: 9, color: gray, lineHeight: 12 });
      y -= 6;
    }

    ensureSpace(40);
    page.drawLine({
      start: { x: MARGIN, y: MARGIN + 18 },
      end: { x: PAGE_W - MARGIN, y: MARGIN + 18 },
      thickness: 0.5,
      color: light,
    });
    page.drawText("Generated by GrowthWise", {
      x: MARGIN,
      y: MARGIN + 4,
      size: 7.5,
      font: regular,
      color: gray,
    });

    const bytes = await pdf.save();
    const filename = `${filenameSafe(order.po_number)}.pdf`;

    return new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  };
}

export default createRetailOrderPdfHandler();
