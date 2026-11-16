(() => {
  const initialize = (root = document) => {
    root.querySelectorAll('[data-product-section]').forEach(section => {
      if (section.dataset.initialized) return;
      section.dataset.initialized = 'true';
      const form = section.querySelector('.pet-product-form');
      const variants = JSON.parse(section.querySelector('[data-product-variants]').textContent);
      const price = section.querySelector('[data-product-price]');
      const addButton = section.querySelector('[data-add-button]');
      const variantSelect = form.querySelector('[data-variant-select]');
      variantSelect?.addEventListener('change', () => {
        const variant = variants.find(item => String(item.id) === variantSelect.value);
        if (!variant) return;
        price.innerHTML = variant.price;
        addButton.disabled = !variant.available;
        addButton.querySelector('[data-add-label]').textContent = variant.available ? addButton.dataset.addLabel : addButton.dataset.soldLabel;
        const url = new URL(window.location.href);
        url.searchParams.set('variant', variant.id);
        window.history.replaceState({}, '', url);
      });
      const mainImage = section.querySelector('[data-main-image]');
      const layout = section.querySelector('[data-photo-layout]');
      const previewPhotos = section.querySelector('[data-preview-photos]');
      const previewToggle = section.querySelector('[data-preview-toggle]');
      const previewName = section.querySelector('[data-preview-name]');
      const petName = form.querySelector('[data-pet-name]');
      const previewStyle = section.querySelector('[data-preview-style]');
      const photoInputs = Array.from(form.querySelectorAll('[data-pet-photo]'));
      const photoStatus = form.querySelector('[data-photo-status]');
      let objectUrls = [];
      const showLayout = () => {
        if (!objectUrls.length) return;
        mainImage.hidden = true;
        layout.hidden = false;
        section.querySelectorAll('[data-gallery-select]').forEach(button => {
          button.classList.remove('selected');
          button.setAttribute('aria-pressed', 'false');
        });
        previewToggle.classList.add('selected');
      };
      section.querySelectorAll('[data-gallery-select]').forEach(button => {
        button.addEventListener('click', () => {
          const image = button.firstElementChild.cloneNode(true);
          if (image.tagName === 'IMG') {
            image.sizes = '(max-width: 700px) 90vw, 48vw';
            image.loading = 'eager';
          }
          mainImage.replaceChildren(image);
          mainImage.hidden = false;
          layout.hidden = true;
          section.querySelectorAll('[data-gallery-select]').forEach(other => {
            other.classList.toggle('selected', other === button);
            other.setAttribute('aria-pressed', String(other === button));
          });
          previewToggle.classList.remove('selected');
        });
      });
      previewToggle?.addEventListener('click', showLayout);
      photoInputs.forEach(input => input.addEventListener('change', () => {
        objectUrls.forEach(url => URL.revokeObjectURL(url));
        objectUrls = [];
        previewPhotos.replaceChildren();
        const names = [];
        photoInputs.forEach(photoInput => {
          photoInput.setCustomValidity('');
          const file = photoInput.files[0];
          if (!file) return;
          const validType = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
          if (!validType || file.size > 10 * 1024 * 1024) {
            photoInput.setCustomValidity(photoInput.dataset.fileError);
            if (photoInput === input) photoInput.reportValidity();
            return;
          }
          const url = URL.createObjectURL(file);
          objectUrls.push(url);
          names.push(file.name);
          const image = document.createElement('img');
          image.src = url;
          image.alt = file.name;
          previewPhotos.append(image);
        });
        photoStatus.textContent = names.join(' · ');
        previewPhotos.className = `preview-photos count-${objectUrls.length}`;
        previewToggle.hidden = !objectUrls.length;
        if (objectUrls.length) showLayout();
        else { mainImage.hidden = false; layout.hidden = true; }
      }));
      petName?.addEventListener('input', () => {
        previewName.textContent = petName.value.trim() || petName.dataset.defaultName;
      });
      const styleRadios = Array.from(form.querySelectorAll('[data-style-key]'));
      const updateStyle = () => {
        const selected = styleRadios.find(radio => radio.checked);
        if (selected) previewStyle.textContent = selected.dataset.styleName;
      };
      styleRadios.forEach(radio => radio.addEventListener('change', updateStyle));
      const requestedStyle = new URLSearchParams(window.location.search).get('style')?.toLowerCase();
      const requestedRadio = styleRadios.find(radio => radio.dataset.styleKey === requestedStyle);
      if (requestedRadio) { requestedRadio.checked = true; updateStyle(); }
      window.addEventListener('pagehide', () => objectUrls.forEach(url => URL.revokeObjectURL(url)), { once: true });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => initialize());
  else initialize();
  document.addEventListener('shopify:section:load', event => initialize(event.target));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') document.querySelectorAll('.mobile-nav[open], .nav-dropdown[open]').forEach(details => {
      details.open = false;
      details.querySelector('summary').focus();
    });
  });
  document.addEventListener('click', event => {
    document.querySelectorAll('.mobile-nav[open], .nav-dropdown[open]').forEach(details => {
      if (!details.contains(event.target) || event.target.closest('a')) details.open = false;
    });
  });
})();
