# MyPetMemo personalized ornament — audit and plan

## Verified facts
- Shopify product 9612228264038 ("Aluminum Ornaments"), 12 variants, linked to Teeinblue (`teeinblue.platform_product`) and Printify (`printify_custom.printify_product_id`).
- Printify: shop 29091709, blueprint 1359, provider 28 (District Photo), one-sided print, position `front`, 236 DPI.
- Exact print areas (px): Medallion 1275x956, Scalloped 1299x924, Square 999x999. The current Teeinblue template is 1600x1600 and must be replaced by one template per shape at these sizes (keep text inside a safe margin).
- Mapping of all 12 variants: `backend/config/printify-variants.json`.
- The Printify product still carries a stock Labrador design and is NOT marked personalizable. Keep it unpublished or on manual order approval until the flow is live.
- The theme's own upload form (`sections/main-product.liquid`) cannot store files in line-item properties; it is to be replaced by the Teeinblue block + approval step.

## Data flow
Product page (Teeinblue: upload, bg removal, AI effect, preview) -> customer approves (`_approved=true`) -> cart properties (`_print_file_url`, `_shape`, ...) -> Shopify payment -> `orders/paid` webhook -> backend gate (paid + approved + file + mapped variant) -> lock (one Printify order per Shopify order) -> Printify DRAFT order -> status metafield. Any failure: hold + error recorded, never a silent retry.

## Stages
1. [done] Variant mapping, order gate, status model, Printify draft client, duplicate lock (`backend/`, 14 tests).
2. [done] `api/orders-paid.js` webhook (HMAC verified), status/lock stored in order metafield `mypetmemo.fulfillment` (compareDigest lock), admin fulfillment hold on error. 19 tests. GraphQL validated against the Shopify schema.
3. Theme: Teeinblue app block on ornament product, approval step, analytics events.
4. [partly done] Image quality checks (`backend/lib/photo-check.js`: format, 15 MB cap, min size, blur, darkness; 27 tests incl. sample dog photo). "Several pets" needs the AI vision step. Remaining: per-shape Teeinblue templates, end-to-end test. Original line: per-shape Teeinblue templates, end-to-end test with sample photo.
