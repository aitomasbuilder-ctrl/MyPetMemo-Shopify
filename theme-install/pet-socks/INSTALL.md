# Install the pet-face socks section

This does not change the published theme. Install it on an unpublished duplicate, then preview the socks product there.

1. In Shopify admin, open Online Store → Themes. Duplicate the live theme. Do not publish the duplicate.
2. Copy these files into that duplicate (edit code, or `shopify theme push --unpublished` aimed at the duplicate only):
   - `sections/pet-face-socks.liquid`
   - `templates/product.pet-socks.json`
   - `assets/pet-socks.js`
   - `assets/pet-socks.css`
   - `assets/sock-pattern.js`
3. On the unpublished theme, assign the product template `pet-socks` to **Golden Retriever Face Socks** (`golden-retriever-face-socks`). The product keeps its current template on the live theme.
4. Preview the duplicate in English and on `/lt-lt/`. Upload 1–4 pet photos. The sock picture should switch to those faces within a few seconds. Add to cart and confirm the line shows Design ID, Pets, and Design preview, with `_design` still present at checkout.
5. Leave the duplicate unpublished until you have checked a paid test order. The backend builds the Printify files only after payment.

The section calls `https://mypetmemo-shopify.vercel.app` (`/api/sock-heads` and `/api/designs`). The shop’s domain must be allowed by `STOREFRONT_ORIGINS` (or `SHOPIFY_SHOP_DOMAIN`) on that project. No new environment variable is required. Cut-out heads are stored in the connected Vercel Blob store.

`sock-pattern.js` must stay identical to `backend/shared/sock-pattern.js`. A backend test checks that.
