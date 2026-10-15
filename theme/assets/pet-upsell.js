/* MyPetMemo matching add-ons: before checkout, offer an ornament and a mug made from the pet the shopper already
 * approved for a blanket or portrait. The pet artwork, photo, name and lettering, background and style are reused
 * from this browser (saved by pet-studio.js when the design was added), or from the cart line's uploaded files
 * on another device. Each add-on is laid out, signed and added exactly like on its own product page.
 * Anything going wrong here never blocks checkout: the shopper is sent on to checkout instead. */
(() => {
  'use strict';

  const root = document.querySelector('[data-pet-upsell]');
  const form = document.getElementById('CartForm');
  if (!root || !form) return;
  let config;
  try { config = JSON.parse(root.querySelector('[data-upsell-config]').textContent); } catch (e) { return; }
  const $ = s => root.querySelector(s);
  const el = {
    offers: $('[data-upsell-offers]'), tpl: $('[data-upsell-card]'), total: $('[data-upsell-total]'), saving: $('[data-upsell-saving]'),
    error: $('[data-upsell-error]'), next: $('[data-upsell-continue]'), close: $('[data-upsell-close]'), mainImg: $('[data-upsell-main-img]')
  };
  const SEEN = 'mpm-upsell-seen';
  let bypass = false, busy = false, cart = null, main = null, cards = [];

  const money = cents => {
    const amount = (Math.max(0, cents) / 100).toFixed(2);
    const fmt = config.moneyFormat || '${{amount}}';
    return fmt.replace(/\{\{\s*(\w+)\s*\}\}/, (m, k) => (k === 'amount_no_decimals' ? String(Math.round(cents / 100)) : k.indexOf('comma') > -1 ? amount.replace('.', ',') : amount))
      .replace(/<[^>]*>/g, '');
  };
  const getCart = async () => (await fetch(config.cartJsUrl, { headers: { Accept: 'application/json' } })).json();
  const seen = () => { try { return JSON.parse(sessionStorage.getItem(SEEN) || '[]'); } catch (e) { return []; } };
  const markSeen = id => { try { sessionStorage.setItem(SEEN, JSON.stringify(seen().concat(id))); } catch (e) { /* private mode */ } };
  const prop = (item, k) => (item.properties || {})[k];

  /** The newest personalized blanket or portrait in the bag that the offer can match. */
  function mainLine(c) {
    return (c.items || []).find(i => config.mainFamilies.includes(prop(i, '_MyPetMemo family')) && !prop(i, '_MyPetMemo add-on') && prop(i, 'Design ID'));
  }
  const bundleLines = (c, id) => (c.items || []).filter(i => prop(i, '_MyPetMemo bundle') === id);
  const isMemorial = item => /memorial/i.test(`${item.handle} ${prop(item, 'Style') || ''}`) || !!prop(item, 'Dates');

  /** Offers for this design: one ornament (memorial or Christmas) and the mug, when those products exist. */
  function offerList(item) {
    const o = config.offers || {}, list = [];
    const orn = (isMemorial(item) && o.memorial) || o.ornament || o.memorial;
    if (orn) list.push({ ...orn, slot: 'ornament' });
    if (o.mug) list.push({ ...o.mug, slot: 'mug' });
    return list;
  }

  /* ----- the approved pet: from this browser, or from the cart line's files ----- */
  async function fileBlob(url) {
    if (!url) return null;
    const res = await fetch(/^\/\//.test(url) ? `https:${url}` : url, { mode: 'cors' });
    if (!res.ok) throw new Error('file');
    return res.blob();
  }
  async function source(item) {
    const S = window.MyPetMemoStudio, id = prop(item, 'Design ID');
    const saved = await S.handoff(id);
    if (saved && saved.art && saved.art.blob && saved.photo) return saved;
    // Another device or a cleared browser: rebuild from the files uploaded with the cart line.
    const [art, photo] = await Promise.all([fileBlob(prop(item, '_artwork')), fileBlob(prop(item, '_Original photo')).catch(() => null)]);
    if (!art) return null;
    const img = await S.loadImage(URL.createObjectURL(art));
    const B = window.MyPetMemoBackgrounds, bgName = prop(item, 'Background');
    const list = (B && (B.all || B.list || B.backgrounds)) || [];
    const bg = (Array.isArray(list) ? list : Object.values(list)).find(b => b && b.name === bgName) || { id: 'white', kind: 'solid', name: 'White', color: '#ffffff' };
    return {
      art: { blob: art, sha256: await S.sha256Hex(art), w: img.naturalWidth, h: img.naturalHeight },
      photo: photo || art,
      name: { text: prop(item, 'Pet name') || '' },
      background: { id: bg.id, kind: bg.kind, name: bg.name, color: bg.color, image: bg.image, preview: bg.preview },
      artStyle: null, extra: { dates: prop(item, 'Dates') || '', message: prop(item, 'Custom text') || '' }
    };
  }

  /* ----- offer cards ----- */
  /** Expected bundle price before adding: the "both" rate once the other add-on is in the bag. */
  function priceFor(card) {
    const pct = cards.some(c => c !== card && c.line) ? config.percentBoth : config.percentOne;
    const was = card.variant.price;
    // Shopify rounds percentage discounts down to the cent.
    return { was, now: was - Math.floor(was * pct / 100), pct };
  }
  function renderCard(card) {
    const n = card.node, p = priceFor(card);
    const line = card.line;
    const was = line ? line.original_line_price : p.was, now = line ? line.final_line_price : p.now;
    n.querySelector('[data-offer-was]').textContent = now < was ? money(was) : '';
    n.querySelector('[data-offer-now]').textContent = money(now);
    n.querySelector('[data-offer-badge]').textContent = now < was ? `Save ${money(was - now)}` : (line ? '' : `${p.pct}% off with your ${main.familyLabel}`);
    const add = n.querySelector('[data-offer-add]');
    add.disabled = card.busy || (!card.designer && !line);
    add.setAttribute('aria-pressed', String(!!line));
    add.classList.toggle('is-added', !!line);
    add.textContent = card.busy ? (line ? 'Removing…' : 'Adding…') : line ? '✓ Added · Remove' : (card.slot === 'mug' ? config.text.addMug : config.text.addOrnament);
  }
  function renderAll() {
    cards.forEach(renderCard);
    const added = cards.some(c => c.line);
    el.next.textContent = added ? config.text.continue : config.text.skip;
    if (cart) {
      el.total.textContent = money(cart.total_price);
      const bundle = cards.reduce((s, c) => s + (c.line ? c.line.original_line_price - c.line.final_line_price : 0), 0);
      el.saving.textContent = bundle > 0 ? `Bundle savings: −${money(bundle)}` : '';
      el.saving.hidden = !(bundle > 0);
    }
  }
  function showError(msg) { el.error.textContent = msg || ''; el.error.hidden = !msg; }

  async function prepare(card, src) {
    const S = window.MyPetMemoStudio;
    const n = card.node;
    n.querySelector('[data-offer-loading-text]').textContent = `Putting ${src.name && src.name.text ? src.name.text : 'your pet'} on the ${card.slot === 'mug' ? 'mug' : 'ornament'}…`;
    try {
      const extra = card.extraFields === 'year' ? { year: String(new Date().getFullYear()) }
        : card.extraFields === 'memorial' ? { dates: (src.extra && src.extra.dates) || '' }
        : { message: '' };
      card.designer = await S.makeAddon({ ...card, extra, style: 'below' }, src);
      const blob = await card.designer.addonPreview();
      const img = n.querySelector('[data-offer-img]');
      img.src = URL.createObjectURL(blob);
      img.alt = `${card.title} with your pet`;
      img.hidden = false;
      n.querySelector('[data-offer-loading]').hidden = true;
    } catch (e) {
      n.querySelector('[data-offer-loading-text]').textContent = 'Preview unavailable';
      card.designer = null;
    }
    renderCard(card);
  }

  async function toggle(card) {
    if (card.busy) return;
    showError('');
    card.busy = true; renderCard(card);
    try {
      if (card.line) {
        await fetch(config.cartChangeUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ id: card.line.key, quantity: 0 }) });
      } else {
        const id = prop(main.item, 'Design ID');
        await card.designer.addonAdd({ 'Matching set': `${main.item.product_title} (${id})`, '_MyPetMemo add-on': 'true', '_MyPetMemo bundle': id });
      }
      await refresh();
    } catch (e) {
      showError(card.line ? 'We couldn’t remove it. Please try again.' : 'We couldn’t add it. Please try again, or continue to checkout.');
    } finally {
      card.busy = false;
      renderAll();
    }
  }
  async function refresh() {
    cart = await getCart();
    const id = prop(main.item, 'Design ID');
    const lines = bundleLines(cart, id);
    cards.forEach(c => { c.line = lines.find(l => prop(l, '_MyPetMemo family') === c.family && l.product_id === c.productId) || null; });
    renderAll();
  }

  /* ----- open / continue ----- */
  function goToCheckout() {
    bypass = true;
    if (main) markSeen(prop(main.item, 'Design ID'));
    window.location.href = config.checkoutUrl;
  }
  async function open() {
    // Save quantity and note edits first, exactly as the bag's own Checkout button would.
    const data = new FormData(form);
    await fetch(config.cartUpdateUrl, { method: 'POST', body: data, headers: { Accept: 'application/json' } });
    cart = await getCart();
    const item = mainLine(cart);
    if (!item || seen().includes(prop(item, 'Design ID')) || !window.MyPetMemoStudio) return false;
    const offers = offerList(item);
    const id = prop(item, 'Design ID');
    const existing = bundleLines(cart, id);
    if (!offers.length || offers.every(o => existing.some(l => prop(l, '_MyPetMemo family') === o.family))) return false;
    const src = await source(item).catch(() => null);
    if (!src) return false;
    main = { item, familyLabel: prop(item, '_MyPetMemo family') === 'portrait' ? 'portrait' : 'blanket' };
    const preview = prop(item, 'Design preview');
    if (preview) { el.mainImg.src = preview; el.mainImg.alt = item.product_title; el.mainImg.hidden = false; }
    el.offers.textContent = '';
    cards = offers.map(o => {
      const node = el.tpl.content.firstElementChild.cloneNode(true);
      node.classList.add(`mpu__card--${o.slot}`);
      const card = { ...o, node, variant: o.variants.find(v => v.id === o.variantId) || o.variants[0], line: null, designer: null };
      node.querySelector('[data-offer-title]').textContent = o.title;
      node.querySelector('[data-offer-desc]').textContent = o.slot === 'mug' ? config.text.mug : config.text.ornament;
      node.querySelector('[data-offer-add]').addEventListener('click', () => toggle(card));
      el.offers.appendChild(node);
      return card;
    });
    await refresh();
    root.showModal();
    // Previews are drawn one after the other so phones stay responsive.
    (async () => { for (const c of cards) await prepare(c, src); })();
    return true;
  }

  form.addEventListener('submit', e => {
    if (bypass || busy) return;
    const submitter = e.submitter;
    if (!submitter || submitter.name !== 'checkout') return;
    e.preventDefault();
    busy = true;
    submitter.setAttribute('aria-busy', 'true');
    const fallback = () => { bypass = true; form.requestSubmit ? form.requestSubmit(submitter) : form.submit(); };
    const timer = setTimeout(() => { if (!root.open) fallback(); }, 8000);
    open().then(shown => { clearTimeout(timer); if (!shown && !bypass) fallback(); })
      .catch(() => { clearTimeout(timer); if (!bypass) fallback(); })
      .finally(() => { busy = false; submitter.removeAttribute('aria-busy'); });
  });
  el.next.addEventListener('click', () => { if (!cards.some(c => c.busy)) goToCheckout(); });
  el.close.addEventListener('click', () => { root.close(); window.location.reload(); });
  root.addEventListener('cancel', e => { e.preventDefault(); el.close.click(); });
})();
