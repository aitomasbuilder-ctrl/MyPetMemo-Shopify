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
  // Anything already on screen at load shows immediately.
  setTimeout(function () {
    items.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) el.classList.add('is-in');
    });
  }, 60);
})();
