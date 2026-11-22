(function () {
  const root = document.querySelector('[data-mpm-socks]');
  if (!root || !window.MpmSockPattern) return;
  const cfg = JSON.parse(root.querySelector('[data-mpm-socks-config]').textContent);
  const P = window.MpmSockPattern;
  const t = key => (cfg.strings && cfg.strings[key]) || key;
  const stage = root.querySelector('[data-stage]');
  const stock = root.querySelector('[data-stock]');
  const statusEl = root.querySelector('[data-status]');
  const errorEl = root.querySelector('[data-error]');
  const list = root.querySelector('[data-photos]');
  const fileLabel = root.querySelector('[data-file-label]');
  const input = root.querySelector('[data-file]');
  const buy = root.querySelector('[data-buy]');
  const pets = [];
  let canvas = null;
  let busy = 0;

  function say(message) { statusEl.textContent = message || ''; }
  function fail(message) { errorEl.textContent = message || ''; }

  function drawDeco(ctx, kind, item) {
    const fill = P.TINTS[item.tint] || '#ffffff';
    ctx.save();
    ctx.translate(item.cx, item.cy);
    ctx.rotate(item.angle * Math.PI / 180);
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (kind === 'paw') {
      const s = item.size;
      P.PAW.toes.forEach(function (e) {
        ctx.ellipse((e[0] - 0.5) * s, (e[1] - 0.5) * s, e[2] * s, e[3] * s, 0, 0, Math.PI * 2);
      });
      const pad = P.PAW.pad;
      ctx.ellipse((pad[0] - 0.5) * s, (pad[1] - 0.5) * s, pad[2] * s, pad[3] * s, 0, 0, Math.PI * 2);
    } else {
      const s = item.size / 100;
      ctx.scale(s, s);
      ctx.translate(-50, -50);
      const path = new Path2D('M50 88C50 88 8 58 8 36C8 18 24 8 38 16C44 20 50 28 50 28C50 28 56 20 62 16C76 8 92 18 92 36C92 58 50 88 50 88Z');
      ctx.fill(path);
    }
    ctx.fill();
    ctx.restore();
  }

  function drawPattern(ctx, plan, images) {
    ctx.fillStyle = P.SOCK_BLUE;
    ctx.fillRect(0, 0, plan.width, plan.height);
    plan.heads.forEach(function (head) {
      const img = images[head.pet];
      if (!img) return;
      ctx.save();
      ctx.translate(head.cx, head.cy);
      ctx.rotate(head.angle * Math.PI / 180);
      const scale = head.w / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height);
      const w = (img.naturalWidth || img.width) * scale;
      const h = (img.naturalHeight || img.height) * scale;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    });
    plan.paws.forEach(function (paw) { drawDeco(ctx, 'paw', paw); });
    plan.hearts.forEach(function (heart) { drawDeco(ctx, 'heart', heart); });
  }

  function sockPath(ctx, x, y, w, h) {
    const r = w * 0.18;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  function paint() {
    const ready = pets.filter(function (p) { return p.img; });
    if (!ready.length) {
      if (canvas) canvas.remove();
      canvas = null;
      if (stock) stock.hidden = false;
      buy.disabled = busy > 0;
      fileLabel.textContent = pets.length ? t('add') : t('upload');
      return;
    }
    if (stock) stock.hidden = true;
    const sockW = 300;
    const legH = Math.round(sockW * (P.SOCK_H / P.SOCK_W));
    const gap = 28;
    const pad = 12;
    const cssW = sockW * 2 + gap + pad * 2;
    const cssH = legH + pad * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!canvas) {
      canvas = document.createElement('canvas');
      stage.appendChild(canvas);
    }
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#f3f1ec';
    ctx.fillRect(0, 0, cssW, cssH);
    const images = ready.map(function (p) { return p.img; });
    ['left', 'right'].forEach(function (side, i) {
      const x = pad + i * (sockW + gap);
      const y = pad;
      const plan = P.layout({ width: sockW, height: legH, petCount: images.length, side: side });
      ctx.save();
      sockPath(ctx, x, y, sockW, legH);
      ctx.clip();
      ctx.translate(x, y);
      drawPattern(ctx, plan, images);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, sockW, sockW * 0.14);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 3;
      for (let k = 4; k < sockW * 0.14; k += 6) {
        ctx.beginPath();
        ctx.moveTo(x + 10, y + k);
        ctx.lineTo(x + sockW - 10, y + k);
        ctx.stroke();
      }
      ctx.restore();
      ctx.fillStyle = '#141414';
      ctx.beginPath();
      ctx.ellipse(x + sockW / 2, y + legH - sockW * 0.08, sockW * 0.5, sockW * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
      const heelX = side === 'left' ? x + sockW * 0.86 : x + sockW * 0.14;
      ctx.beginPath();
      ctx.ellipse(heelX, y + legH * 0.78, sockW * 0.2, sockW * 0.16, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    buy.disabled = busy > 0;
    fileLabel.textContent = pets.length >= cfg.maxPets ? t('full') : t('add');
    if (!busy) say(t('ready'));
  }

  function thumb(pet) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.alt = '';
    img.src = pet.previewUrl;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t('remove');
    button.addEventListener('click', function () {
      const at = pets.indexOf(pet);
      if (at >= 0) pets.splice(at, 1);
      li.remove();
      fail('');
      paint();
    });
    li.append(img, button);
    list.appendChild(li);
    pet.thumb = img;
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function cutOne(file) {
    const body = new FormData();
    body.append('image', file, file.name || 'pet.jpg');
    const res = await fetch(cfg.api.replace(/\/$/, '') + '/api/sock-heads', { method: 'POST', body: body });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || t('fail'));
    const img = await loadImage(data.image);
    return { url: data.url, sha256: data.sha256, img: img, previewUrl: data.image };
  }

  input.addEventListener('change', async function () {
    fail('');
    const files = Array.from(input.files || []);
    input.value = '';
    const room = cfg.maxPets - pets.length;
    if (!files.length || room <= 0) return;
    if (files.length > room) fail(t('tooMany'));
    const batch = files.slice(0, room);
    busy += batch.length;
    buy.disabled = true;
    for (let i = 0; i < batch.length; i++) {
      say(t('cutting').replace('{n}', String(pets.length + 1)).replace('{total}', String(Math.min(cfg.maxPets, pets.length + batch.length - i))));
      try {
        const pet = await cutOne(batch[i]);
        pets.push(pet);
        thumb(pet);
        paint();
      } catch (err) {
        fail(err && err.message ? err.message : t('fail'));
      }
      busy--;
    }
    paint();
  });

  buy.addEventListener('click', async function () {
    const ready = pets.filter(function (p) { return p.url && p.sha256; });
    if (!ready.length || busy) return;
    fail('');
    buy.disabled = true;
    say(t('adding'));
    try {
      const design = {
        family: 'socks',
        product_id: String(cfg.productId),
        variant_id: String(cfg.variantId),
        sku: cfg.sku || '',
        pets: ready.map(function (p) { return { url: p.url, sha256: p.sha256 }; })
      };
      const approved = await fetch(cfg.api.replace(/\/$/, '') + '/api/designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ design: design })
      });
      const approval = await approved.json().catch(function () { return {}; });
      if (!approved.ok || !approval.token) throw new Error(approval.message || t('fail'));
      const preview = await new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.86); });
      const form = new FormData();
      form.append('id', String(cfg.variantId));
      form.append('quantity', '1');
      form.append('properties[' + t('designId') + ']', approval.id);
      form.append('properties[' + t('pets') + ']', String(ready.length));
      if (preview) form.append('properties[' + t('preview') + ']', preview, approval.id + '-preview.jpg');
      form.append('properties[_design]', approval.token);
      ready.forEach(function (p, i) { form.append('properties[_pet_' + (i + 1) + ']', p.url); });
      const added = await fetch(cfg.cartAdd + '.js', { method: 'POST', body: form, headers: { Accept: 'application/json' } });
      if (!added.ok) throw new Error(t('cartFail'));
      window.location.assign(cfg.cart);
    } catch (err) {
      fail(err && err.message ? err.message : t('fail'));
      buy.disabled = false;
      say('');
    }
  });
})();
