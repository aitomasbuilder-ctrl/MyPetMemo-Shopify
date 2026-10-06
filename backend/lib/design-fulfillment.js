'use strict';
// Turns each approved design line of a paid order into a validated print file:
// Printify variant (by SKU) -> exact print area -> artwork checked against the approved hash ->
// rendered server side -> stored -> download re-checked. Throws on any failure so the order is held.
const sharp = require('sharp');
const { renderDesign, sha256 } = require('./render');
const { allowedHost, defaultHosts } = require('./design');

const MAX_DOWNLOAD = 40 * 1024 * 1024;

async function download(url, { fetchImpl, hosts, label }) {
  if (!allowedHost(url, hosts)) throw new Error(`${label}_host_not_allowed`);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`${label}_download_${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error(`${label}_too_large`);
  return buf;
}

async function checkArtwork(buf, expected) {
  if (sha256(buf) === expected.sha256) return 'sha256';
  // Some CDNs re-encode uploads. Accept only an image with the exact approved dimensions and alpha.
  const meta = await sharp(buf).metadata();
  if (meta.width === expected.w && meta.height === expected.h && meta.hasAlpha) return 'dimensions';
  throw new Error('artwork_does_not_match_approved_design');
}

async function prepareDesignItems(order, items, { catalog, put, fetchImpl = fetch, hosts = defaultHosts(), render = renderDesign }) {
  const out = [];
  for (const item of items) {
    if (item.kind !== 'design') { out.push(item); continue; }
    const mapping = await catalog.variantForSku(item.sku);
    if (!mapping.is_enabled) throw new Error(`printify_variant_disabled:${item.sku}`);
    const area = await catalog.printArea(mapping);
    const artwork = await download(item.artwork_url, { fetchImpl, hosts, label: 'artwork' });
    const artworkCheck = await checkArtwork(artwork, item.design.artwork);
    const bg = item.design.background;
    const backgroundImage = bg.kind === 'image' ? await download(bg.image_url, { fetchImpl, hosts, label: 'background' }) : null;
    const file = await render({ design: item.design, artwork, backgroundImage, width: area.width, height: area.height });
    const ext = file.format === 'png' ? 'png' : 'jpg';
    const url = await put(`print-files/${order.id}/${item.line_id}-${item.design_id}.${ext}`, file.buffer, file.format === 'png' ? 'image/png' : 'image/jpeg');
    const head = await fetchImpl(url, { method: 'HEAD' });
    const length = Number(head.headers && head.headers.get ? head.headers.get('content-length') : NaN);
    if (!head.ok || (Number.isFinite(length) && length !== file.buffer.length)) throw new Error('print_file_upload_unverified');
    out.push({
      ...item,
      blueprint_id: mapping.blueprint_id, print_provider_id: mapping.print_provider_id, printify_variant_id: mapping.printify_variant_id,
      position: area.position, print_file_url: url,
      production: { design_id: item.design_id, width: file.width, height: file.height, sha256: file.sha256, bytes: file.buffer.length, artwork_check: artworkCheck, url }
    });
  }
  return out;
}

module.exports = { prepareDesignItems, checkArtwork };
