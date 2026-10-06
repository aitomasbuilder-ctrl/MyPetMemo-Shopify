'use strict';
// Approved blanket and ornament designs. A design is a small JSON document (all positions normalised to the
// print area) that the storefront sends for approval. The backend validates it, gives it an id
// derived from its content and signs it; the signed token travels with the cart line into the
// order, so the paid order carries exactly the version the customer approved.
const crypto = require('node:crypto');
const backgrounds = require('../shared/pet-backgrounds');
const { FONTS } = require('./fonts');
const { missingCharacters } = require('./text-path');

const VERSION = 2;
const HEX = /^#[0-9a-f]{6}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ID = /^\d{1,20}$/;
const NAME_MAX = 24;
const SHAPES = new Set(['circle', 'heart', 'star', 'snowflake']); // ornament outlines (preview only; Printify cuts the blank)

class DesignError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

const num = (v, min, max, field) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new DesignError('invalid_number', `${field} must be between ${min} and ${max}`);
  return Math.round(n * 10000) / 10000;
};
const str = (v, re, field) => {
  const s = String(v == null ? '' : v);
  if (!re.test(s)) throw new DesignError('invalid_field', `${field} is invalid`);
  return s;
};

function allowedHost(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  return u.protocol === 'https:' && hosts.includes(u.hostname.toLowerCase());
}

function defaultHosts(env = process.env) {
  return String(env.ALLOWED_ASSET_HOSTS || 'cdn.shopify.com,mypetmemo.com,www.mypetmemo.com')
    .split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
    .concat(env.SHOPIFY_SHOP_DOMAIN ? [env.SHOPIFY_SHOP_DOMAIN.toLowerCase()] : []);
}

function normaliseBackground(bg, hosts) {
  if (!bg || typeof bg !== 'object') throw new DesignError('background_missing');
  const kind = String(bg.kind || '');
  if (kind === 'image') {
    if (!allowedHost(bg.image_url, hosts)) throw new DesignError('background_host', 'background image must come from the store');
    return { id: str(bg.id, /^[a-z0-9-]{1,60}$/, 'background.id'), kind, name: String(bg.name || '').slice(0, 60), color: HEX.test(bg.color || '') ? bg.color.toLowerCase() : '#ffffff', image_url: String(bg.image_url) };
  }
  if (bg.id === 'custom') {
    if (!HEX.test(bg.color || '')) throw new DesignError('background_color');
    return { id: 'custom', kind: 'solid', name: String(bg.name || 'Custom color').slice(0, 60), color: bg.color.toLowerCase() };
  }
  const def = backgrounds.byId[bg.id];
  if (!def) throw new DesignError('background_unknown', `unknown background ${bg.id}`);
  return { id: def.id, kind: def.kind, name: def.name, color: def.color };
}

function normaliseName(n) {
  if (!n || !String(n.text || '').trim()) return null;
  const text = String(n.text).normalize('NFC').replace(/\s+/g, ' ').trim();
  if (Array.from(text).length > NAME_MAX) throw new DesignError('name_too_long', `name is longer than ${NAME_MAX} characters`);
  const font = String(n.font || 'fredoka');
  if (!FONTS[font]) throw new DesignError('font_unknown');
  const missing = missingCharacters(text, font);
  if (missing.length) throw new DesignError('name_characters', `These characters can't be printed in this font: ${missing.join(' ')}`);
  return {
    text, font,
    cx: num(n.cx, -0.5, 1.5, 'name.cx'), cy: num(n.cy, -0.5, 1.5, 'name.cy'),
    size: num(n.size, 0.01, 0.6, 'name.size'), rot: num(n.rot || 0, -180, 180, 'name.rot'),
    fill: str(String(n.fill || '#ffffff').toLowerCase(), HEX, 'name.fill'),
    stroke: str(String(n.stroke || '#2a2230').toLowerCase(), HEX, 'name.stroke')
  };
}

/** Validates client input and returns the canonical design (fixed key order, rounded numbers). */
function normalise(input, { hosts = defaultHosts() } = {}) {
  if (!input || typeof input !== 'object') throw new DesignError('design_missing');
  const a = input.artwork || {};
  const family = input.family === 'ornament' ? 'ornament' : 'blanket';
  const shape = family === 'ornament' ? (SHAPES.has(input.shape) ? input.shape : 'circle') : undefined;
  return {
    v: VERSION,
    family,
    ...(shape ? { shape } : {}),
    product_id: str(input.product_id, ID, 'product_id'),
    variant_id: str(input.variant_id, ID, 'variant_id'),
    sku: String(input.sku || '').slice(0, 64),
    print: { w: Math.round(num(input.print && input.print.w, 100, 30000, 'print.w')), h: Math.round(num(input.print && input.print.h, 100, 30000, 'print.h')) },
    background: normaliseBackground(input.background, hosts),
    pet: {
      cx: num(input.pet && input.pet.cx, -0.5, 1.5, 'pet.cx'), cy: num(input.pet && input.pet.cy, -0.5, 1.5, 'pet.cy'),
      w: num(input.pet && input.pet.w, 0.05, 3, 'pet.w'), rot: num((input.pet && input.pet.rot) || 0, -180, 180, 'pet.rot')
    },
    name: normaliseName(input.name),
    artwork: { sha256: str(String(a.sha256 || '').toLowerCase(), SHA, 'artwork.sha256'), w: Math.round(num(a.w, 64, 20000, 'artwork.w')), h: Math.round(num(a.h, 64, 20000, 'artwork.h')) }
  };
}

const b64 = buf => Buffer.from(buf).toString('base64url');
const canonical = d => JSON.stringify(d);
const designId = d => 'MPM-' + crypto.createHash('sha256').update(canonical(d)).digest('hex').slice(0, 10).toUpperCase();

function secret(env = process.env) {
  const s = env.DESIGN_SIGNING_SECRET;
  if (!s || s.length < 32) throw new DesignError('signing_not_configured', 'DESIGN_SIGNING_SECRET (32+ characters) is not set');
  return s;
}

function sign(design, key = secret()) {
  const body = b64(canonical(design));
  const mac = b64(crypto.createHmac('sha256', key).update(body).digest());
  return { id: designId(design), token: `${body}.${mac}` };
}

/** Returns the design inside a token, or throws DesignError('bad_signature'). */
function verify(token, key = secret()) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) throw new DesignError('bad_token');
  const expected = crypto.createHmac('sha256', key).update(body).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw new DesignError('bad_signature');
  const design = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (design.v !== VERSION) throw new DesignError('bad_version');
  return { design, id: designId(design) };
}

module.exports = { normalise, sign, verify, designId, allowedHost, defaultHosts, DesignError, VERSION };
