/* Redesign 2026-11: gentle fade-up of blocks as they scroll into view, and a header shadow after scrolling.
   Content is visible without JavaScript; the hidden start state only applies once html has .rd-anim. */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var header = document.querySelector('.header');
  if (header) {
    var onScroll = function () { header.classList.toggle('is-scrolled', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
  // Product pages: secure-payment row with the store's real payment icons under the delivery box.
  var delivery = document.querySelector('.mps .mpm-delivery, .mpp .mpm-delivery');
  var pay = document.querySelector('.rd-footer__pay');
  if (delivery && pay && !document.querySelector('.rd-paytrust')) {
    var lt = (document.documentElement.lang || '').indexOf('lt') === 0;
    var row = document.createElement('div');
    row.className = 'rd-paytrust';
    row.innerHTML = '<p><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' +
      (lt ? 'Saugus apmokėjimas' : 'Secure checkout') + '</p>';
    var list = pay.cloneNode(true);
    list.removeAttribute('aria-label');
    list.className = 'rd-paytrust__icons';
    row.appendChild(list);
    delivery.parentNode.insertBefore(row, delivery.nextSibling);
  }
  if (reduce || !('IntersectionObserver' in window)) return;
  var selectors = [
    '[data-rd-reveal]', '.rd-heading', '.rd-grid__item', '.rd-tile', '.rd-steps__list > li',
    '.rd-story__media', '.rd-story__copy', '.rd-usp__list > li', '.transformation .transformation-step',
    '.faq-section details', '.mpc-card', '.collection-grid .product-card', '.mps-steps__item'
  ];
  var items = document.querySelectorAll(selectors.join(','));
  if (!items.length) return;
  document.documentElement.classList.add('rd-anim');
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  items.forEach(function (el) {
    var siblings = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
    el.classList.add('rd-reveal');
    el.style.transitionDelay = Math.min(siblings, 5) * 70 + 'ms';
    io.observe(el);
  });
  // Safety net: anything that is on screen or already scrolled past is shown, even if the observer missed it.
  var pending = true;
  function sweep() {
    pending = false;
    var left = 0;
    items.forEach(function (el) {
      if (el.classList.contains('is-in')) return;
      if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add('is-in'); else left++;
    });
    if (!left) window.removeEventListener('scroll', onSweep);
  }
  function onSweep() { if (!pending) { pending = true; setTimeout(sweep, 150); } }
  window.addEventListener('scroll', onSweep, { passive: true });
  setTimeout(sweep, 60);
})();
