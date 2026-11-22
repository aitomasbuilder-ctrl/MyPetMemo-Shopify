'use strict';
// Turns each approved design line of a paid order into a validated print file:
// Printify variant (by SKU) -> exact print area -> artwork checked against the approved hash ->
// rendered server side -> stored -> download re-checked. Throws on any failure so the order is held.
// Digital portraits skip Printify: they are rendered at the approved file size (300 dpi) for download.
const sharp = require('sharp');
const { renderDesign, renderTee, sha256 } = require('./render');
const { renderSock, SOCK_W, SOCK_H } = require('./sock-render');
const { allowedHost, defaultHosts } = require('./design');
const { upscaleArtwork } = require('./upscale');

const MAX_DOWNLOAD = 40 * 1024 * 1024;
// Shared across every design in one order. One full scene is ~90s here; leave the rest of the 300s for render and upload.
const UPSCALE_BUDGET_MS = () => {
  const n = Number(process.env.UPSCALE_BUDGET_MS || 160000);
  return Number.isFinite(n) && n > 0 ? n : 160000;
};

/** Pet width in print pixels. Mug positions are fractions of one side, not the whole wrap. */
function petPrintWidth(design, printWidth) {
  const span = design && design.sides === 2 ? Math.round(printWidth / 2) : printWidth;
  return Math.round((((design && design.pet && design.pet.w) || 0) * span));
}

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

async function prepareDesignItems(order, items, { catalog, put, fetchImpl = fetch, hosts = defaultHosts(), render = renderDesign, printfulRoute = null, upscale = upscaleArtwork }) {
  const out = [];
  const deadline = Date.now() + UPSCALE_BUDGET_MS();
  for (const item of items) {
    if (item.kind !== 'design') { out.push(item); continue; }
    if (item.design.family === 'socks') {
      out.push(await prepareSocks(order, item, { catalog, put, fetchImpl, hosts }));
      continue;
    }
    let mapping = null, area, printful = null;
    if (item.digital) {
      area = { width: item.design.print.w, height: item.design.print.h };
      if (Math.max(area.width, area.height) < 3000) throw new Error('digital_file_too_small');
    } else {
      mapping = await catalog.variantForSku(item.sku);
      if (!mapping.is_enabled) throw new Error(`printify_variant_disabled:${item.sku}`);
      if (catalog.regionalVariant) mapping = await catalog.regionalVariant(mapping, order.shipping_address && order.shipping_address.country_code, { family: item.design.family });
      area = await catalog.printArea(mapping);
      // EU blankets go to Printful in Europe unless Printify already found an EU maker.
      if (printfulRoute && item.design.family !== 'tee' && !mapping.region) printful = await printfulRoute(mapping, area, order.shipping_address && order.shipping_address.country_code);
    }
    const W = printful ? printful.width : area.width, H = printful ? printful.height : area.height;
    let file, artworkCheck, up = null;
    if (item.design.family === 'tee') {
      const pets = [];
      for (const pet of item.design.pets) {
        const buf = await download(pet.url, { fetchImpl, hosts, label: 'artwork' });
        if (sha256(buf) !== pet.sha256) throw new Error('artwork_does_not_match_approved_design');
        pets.push(buf);
      }
      file = await renderTee({ design: item.design, pets, width: W, height: H });
      artworkCheck = 'sha256';
    } else {
      const artwork = await download(item.artwork_url, { fetchImpl, hosts, label: 'artwork' });
      artworkCheck = await checkArtwork(artwork, item.design.artwork);
      const bg = item.design.background;
      const backgroundImage = bg.kind === 'image' ? await download(bg.image_url, { fetchImpl, hosts, label: 'background' }) : null;
      // Checked artwork only. The upscaler itself stays off unless UPSCALE_ARTWORK=on.
      up = upscale && item.design.pet ? await upscale(artwork, { printedWidth: petPrintWidth(item.design, W), deadline }) : null;
      file = await render({ design: item.design, artwork: up ? up.buffer : artwork, backgroundImage, width: W, height: H, ...(item.digital ? { dpi: 300 } : {}) });
    }
    if (printful && printful.rotate) file = await rotated(file);
    const ext = file.format === 'png' ? 'png' : 'jpg';
    const folder = item.digital ? 'digital' : 'print-files';
    const url = await put(`${folder}/${order.id}/${item.line_id}-${item.design_id}.${ext}`, file.buffer, file.format === 'png' ? 'image/png' : 'image/jpeg');
    const head = await fetchImpl(url, { method: 'HEAD' });
    const length = Number(head.headers && head.headers.get ? head.headers.get('content-length') : NaN);
    if (!head.ok || (Number.isFinite(length) && length !== file.buffer.length)) throw new Error('print_file_upload_unverified');
    out.push({
      ...item,
      ...(printful ? { fulfiller: 'printful', printful_variant_id: printful.printful_variant_id } : {}),
      ...(mapping ? { blueprint_id: mapping.blueprint_id, print_provider_id: mapping.print_provider_id, printify_variant_id: mapping.printify_variant_id, position: area.position } : {}),
      print_file_url: url,
      production: { design_id: item.design_id, width: file.width, height: file.height, sha256: file.sha256, bytes: file.buffer.length, artwork_check: artworkCheck, upscaled: !!(up && up.upscaled), url }
    });
  }
  return out;
}

// Both sock legs, at the catalog size. Nothing here runs before the order is paid.
async function prepareSocks(order, item, { catalog, put, fetchImpl, hosts }) {
  if (!catalog.printAreas) throw new Error('sock_print_areas_unavailable');
  const mapping = await catalog.variantForSku(item.sku);
  if (!mapping.is_enabled) throw new Error(`printify_variant_disabled:${item.sku}`);
  const legs = (await catalog.printAreas(mapping))
    .filter(area => area.position === 'left_leg' || area.position === 'right_leg')
    .sort((a, b) => (a.position < b.position ? -1 : 1));
  if (legs.length !== 2) throw new Error('sock_print_areas_incomplete');
  for (const area of legs) {
    if (area.width !== SOCK_W || area.height !== SOCK_H) throw new Error(`sock_print_size:${area.position}:${area.width}x${area.height}`);
  }
  const pets = [];
  for (const pet of item.design.pets) {
    const buf = await download(pet.url, { fetchImpl, hosts, label: 'artwork' });
    if (sha256(buf) !== pet.sha256) throw new Error('artwork_does_not_match_approved_design');
    pets.push(buf);
  }
  const files = [];
  for (const area of legs) {
    const side = area.position === 'left_leg' ? 'left' : 'right';
    const file = await renderSock({ pets, side, width: area.width, height: area.height });
    const url = await put(`print-files/${order.id}/${item.line_id}-${item.design_id}-${area.position}.png`, file.buffer, 'image/png');
    const head = await fetchImpl(url, { method: 'HEAD' });
    const length = Number(head.headers && head.headers.get ? head.headers.get('content-length') : NaN);
    if (!head.ok || (Number.isFinite(length) && length !== file.buffer.length)) throw new Error('print_file_upload_unverified');
    files.push({ position: area.position, url, sha256: file.sha256, width: file.width, height: file.height, bytes: file.buffer.length });
  }
  return {
    ...item,
    blueprint_id: mapping.blueprint_id,
    print_provider_id: mapping.print_provider_id,
    printify_variant_id: mapping.printify_variant_id,
    position: files[0].position,
    print_file_url: files[0].url,
    print_files: files.map(file => ({ position: file.position, url: file.url })),
    production: {
      design_id: item.design_id,
      width: files[0].width,
      height: files[0].height,
      sha256: files.map(file => file.sha256).join(','),
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      artwork_check: 'sha256',
      upscaled: false,
      url: files[0].url,
      files: files.map(file => ({ position: file.position, url: file.url, sha256: file.sha256, width: file.width, height: file.height }))
    }
  };
}

// Turns a rendered print file 90° (Printful's blanket file is the other way round from the design).
async function rotated(file) {
  const img = sharp(file.buffer).rotate(90);
  const buffer = file.format === 'png' ? await img.png().toBuffer() : await img.jpeg({ quality: 95 }).toBuffer();
  return { ...file, buffer, width: file.height, height: file.width, sha256: sha256(buffer) };
}

module.exports = { prepareDesignItems, checkArtwork, petPrintWidth, prepareSocks };
