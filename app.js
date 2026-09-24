window.addEventListener('error', (event) => {
  const app = document.getElementById('app');
  if (app && !app.innerHTML.trim()) {
    app.innerHTML = `<div class="wrap"><div class="panel"><h2>Store</h2><p>There was a problem loading the storefront.</p><p class="muted">Please refresh the page. If the problem continues, contact support.</p></div></div>`;
  }
});

const state = {
  view: 'store', // store | confirm | admin-auth | admin | about | services | contacts
  loading: true,
  products: [],
  categories: [],
  provinces: [],
  deliveryWindows: [],
  activeCategory: 'All',
  searchQuery: '',
  sortBy: 'best', // best | price-asc | price-desc
  recommendations: [],
  cart: {}, // retained internally for compatibility; storefront no longer exposes a cart
  services: [],
  hasAdmin: false,
  isAdmin: false,
  adminTab: 'stock', // stock | services | admins
  adminAccounts: [],
  adminUsername: null,
  navOpen: false,
  settings: { storeName: 'Online Store', tagline: 'Quality goods, delivered across Zambia.', currency: 'ZMW', whatsappNumber: '260779173957', supportPhone: '+260779173957', aboutText: '', storeAddress: '', contactEmail: '', facebookUrl: '', instagramUrl: '', tiktokUrl: '' },
  cartOpen: false,
  orderDraft: { productId: null, qty: 1 },
  toast: null,
  editingProductId: null,
  editingServiceId: null,
  authError: '',
  lastOrderId: null,
  lastOrderWhatsappUrl: null,
  reviewsOpenFor: null,
  reviewsCache: {},
  selectedProductId: null,
};

/* ---------------- API helper ---------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || 'Something went wrong');
    err.status = res.status;
    throw err;
  }
  return data;
}

function money(n) {
  return state.settings.currency + ' ' + Number(n || 0).toFixed(2);
}
// Mirrors the server's unitPriceFor() so the storefront can show/preview the
// bulk-discount price before an order is submitted. The server always
// recalculates the real price at checkout, so this is display-only.
function unitPriceFor(product, qty) {
  if (product && product.discountQty && product.discountPrice != null && qty >= product.discountQty) {
    return Number(product.discountPrice);
  }
  return Number(product.price);
}
function discountBadgeHtml(p) {
  if (!p.discountQty || p.discountPrice == null) return '';
  return `<div class="discount-note">Buy ${p.discountQty}+ at ${money(p.discountPrice)} each</div>`;
}
function whatsappUrl(message = '') {
  let n = String(state.settings.whatsappNumber || '').replace(/\D/g, '');
  if (n.startsWith('0')) n = '260' + n.slice(1);
  if (n.startsWith('260')) return 'https://wa.me/' + n + (message ? '?text=' + encodeURIComponent(message) : '');
  return '#';
}
function showToast(msg) {
  state.toast = msg;
  render();
  setTimeout(() => { state.toast = null; render(); }, 2500);
}

/* ---------------- "What you like" affinity tracking ----------------
 * No customer accounts exist on the storefront, so this runs entirely in
 * the shopper's own browser (localStorage) — no personal data leaves the
 * device for this. It just remembers which categories this browser has
 * shown interest in (via cart adds, weighted higher, and category browsing)
 * so we can ask the server for a "you might like" set. The server-side
 * ranking itself (see /api/recommendations) uses real order history, not
 * this — this only supplies "which category to lean toward".
 */
function loadAffinity() {
  try { return JSON.parse(localStorage.getItem('gw_affinity') || '{}'); } catch (e) { return {}; }
}
function trackAffinity(type, category) {
  if (!category) return;
  try {
    const aff = loadAffinity();
    aff.categories = aff.categories || {};
    aff.categories[category] = (aff.categories[category] || 0) + (type === 'cartAdd' ? 3 : 1);
    localStorage.setItem('gw_affinity', JSON.stringify(aff));
  } catch (e) { /* localStorage unavailable — recommendations just fall back to popularity */ }
}
function topAffinityCategory() {
  const cats = loadAffinity().categories || {};
  let best = null, bestScore = 0;
  for (const [cat, score] of Object.entries(cats)) { if (score > bestScore) { best = cat; bestScore = score; } }
  return best;
}
async function refreshRecommendations() {
  const params = new URLSearchParams();
  const category = topAffinityCategory();
  if (category) params.set('category', category);
  params.set('limit', '6');
  try {
    state.recommendations = await api('/api/recommendations?' + params.toString());
    render();
  } catch (e) { /* non-critical — leave whatever was there */ }
}

/* ---------------- Init ---------------- */
async function init() {
  try {
    const [products, settings, adminStatus, categories, services, provinces, deliveryWindows] = await Promise.all([
      api('/api/products'),
      api('/api/settings'),
      api('/api/admin/status'),
      api('/api/categories'),
      api('/api/services'),
      api('/api/provinces'),
      api('/api/delivery-windows'),
    ]);
    state.products = products;
    state.settings = settings;
    document.title = settings.storeName || 'Online Store';
    state.hasAdmin = adminStatus.hasAdmin;
    state.categories = categories;
    state.services = services;
    state.provinces = provinces;
    state.deliveryWindows = deliveryWindows;
    try {
      const me = await api('/api/admin/me');
      state.isAdmin = true;
      state.adminUsername = me.username;
    } catch (e) { /* not logged in, fine */ }
  } catch (e) {
    showToast('Could not reach the server: ' + e.message);
  }
  const orderProductId = new URLSearchParams(window.location.search).get('order');
  if (orderProductId) {
    const orderProduct = state.products.find(p => p.id === orderProductId);
    if (orderProduct && Number(orderProduct.qty) > 0) {
      state.orderDraft = { productId: orderProductId, qty: 1 };
      state.view = 'checkout';
      state.navOpen = false;
      state.cartOpen = false;
      state.reviewsOpenFor = null;
    }
    history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  }
  state.loading = false;
  render();
  setTimeout(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }), 0);
  refreshRecommendations();
}

/* ---------------- Search & category filtering ---------------- */
let searchDebounce = null;
function handleSearchInput(value) {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { state.searchQuery = value; render(); }, 200);
}
function triggerSearch() {
  const input = document.getElementById('search-input');
  state.searchQuery = input ? input.value : state.searchQuery;
  render();
}
function setCategory(cat) {
  state.activeCategory = cat;
  state.navOpen = false;
  if (cat !== 'All') trackAffinity('category', cat);
  render();
  refreshRecommendations();
}
function setSort(value) { state.sortBy = value; render(); }
function visibleProducts() {
  let list = state.products;
  if (state.activeCategory !== 'All') list = list.filter(p => p.category === state.activeCategory);
  const q = state.searchQuery.trim().toLowerCase();
  if (q) list = list.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
  list = [...list];
  if (state.sortBy === 'price-asc') list.sort((a, b) => a.price - b.price);
  else if (state.sortBy === 'price-desc') list.sort((a, b) => b.price - a.price);
  return list;
}

/* ---------------- Direct order flow ---------------- */
/* ---------------- Checkout ---------------- */
async function submitOrder(formEl) {
  const data = new FormData(formEl);
  const customerName = (data.get('name') || '').trim();
  const phone = (data.get('phone') || '').trim();
  const altPhone = (data.get('altPhone') || '').trim();
  const email = (data.get('email') || '').trim();
  const town = (data.get('town') || '').trim();
  const province = (data.get('province') || '').trim();
  const address = (data.get('address') || '').trim();
  const deliveryDate = (data.get('deliveryDate') || '').trim();
  const deliveryWindow = (data.get('deliveryWindow') || '').trim();
  const notes = (data.get('notes') || '').trim();
  const agreed = data.get('agreement') === 'on';
  // Quantity is displayed in the order summary card, outside the customer form.
  // FormData(formEl) therefore does not include it; read the live quantity input directly.
  const qtyRaw = String(document.getElementById('order-qty')?.value || '').trim();
  const qty = Number(qtyRaw);
  const productId = state.orderDraft.productId;
  const product = state.products.find(p => p.id === productId);

  if (!product) { showToast('Product not found. Please return to the store and try again.'); return; }
  const availableStock = Number(product.qty);
  if (!Number.isInteger(availableStock) || availableStock < 0) {
    showToast('This product has an invalid stock value. Please contact ' + state.settings.storeName + '.');
    return;
  }
  if (!Number.isInteger(qty) || qty < 1) {
    showToast('Please enter a whole-number quantity of at least 1.');
    return;
  }
  if (qty > availableStock) {
    showToast(`Only ${availableStock} unit${availableStock === 1 ? '' : 's'} of this product ${availableStock === 1 ? 'is' : 'are'} currently available.`);
    return;
  }
  if (!customerName || !phone || !town || !province || !address) {
    showToast('Please fill in name, phone, town, province and address');
    return;
  }
  if (!agreed) { showToast('Please read and accept the Policy & Agreement before placing your order'); return; }

  try {
    const result = await api('/api/orders', {
      method: 'POST',
      body: { items: [{ id: product.id, qty }], customerName, phone, altPhone, email, town, province, address, deliveryDate, deliveryWindow, notes },
    });
    state.lastOrderId = result.orderId;
    state.lastOrderWhatsappUrl = result.whatsappUrl || null;
    state.orderDraft = { productId: null, qty: 1 };
    state.view = 'confirm';
    state.products = await api('/api/products');
    render();
    refreshRecommendations();
  } catch (e) {
    showToast(e.message);
  }
}

function startOrder(id) {
  const product = state.products.find(p => p.id === id);
  if (!product) { showToast('Product not found'); return; }
  const availableStock = Number(product.qty);
  if (!Number.isInteger(availableStock) || availableStock <= 0) { showToast('This product is currently out of stock'); return; }
  state.orderDraft = { productId: id, qty: 1 };
  state.view = 'checkout';
  state.navOpen = false;
  state.reviewsOpenFor = null;
  state.cartOpen = false;
  render();
  setTimeout(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }), 0);
}

function cancelOrder() {
  state.orderDraft = { productId: null, qty: 1 };
  state.view = 'store';
  render();
}

function setOrderQty(value) {
  const product = state.products.find(p => p.id === state.orderDraft.productId);
  const availableStock = product ? Number(product.qty) : 0;
  let qty = Number(String(value).trim());
  if (!product || !Number.isInteger(availableStock) || availableStock < 1 || !Number.isInteger(qty)) return;
  qty = Math.max(1, Math.min(availableStock, qty));
  state.orderDraft.qty = qty;
  const input = document.getElementById('order-qty');
  if (input) input.value = qty;
  const total = document.getElementById('order-total');
  if (total) total.textContent = money(unitPriceFor(product, qty) * qty);
  // Keep the +/- buttons in sync without a full re-render (a full render()
  // would wipe out any name/phone/address text the customer already typed
  // into the surrounding checkout form).
  const minusBtn = document.getElementById('order-qty-minus');
  if (minusBtn) minusBtn.disabled = qty <= 1;
  const plusBtn = document.getElementById('order-qty-plus');
  if (plusBtn) plusBtn.disabled = qty >= availableStock;
}

function adjustOrderQty(delta) {
  // Read the live input value rather than a number baked into the button's
  // onclick at render time, so repeated clicks keep incrementing/decrementing
  // instead of freezing after the first click.
  const input = document.getElementById('order-qty');
  const current = Number(input ? input.value : state.orderDraft.qty) || state.orderDraft.qty || 1;
  setOrderQty(current + delta);
}

/* ---------------- Reviews ---------------- */
async function openReviews(id) {
  state.reviewsOpenFor = id;
  state.cartOpen = false;
  render();
  try {
    state.reviewsCache[id] = await api('/api/products/' + id + '/reviews');
    render();
  } catch (e) { showToast(e.message); }
}
function closeReviews() { state.reviewsOpenFor = null; render(); }

function openProduct(id) {
  const product = state.products.find(p => p.id === id);
  if (!product) { showToast('Product not found'); return; }
  state.selectedProductId = id;
  state.view = 'product';
  state.navOpen = false;
  state.cartOpen = false;
  state.reviewsOpenFor = null;
  render();
  setTimeout(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }), 0);
}

function closeProduct() {
  state.selectedProductId = null;
  state.view = 'store';
  render();
}
async function submitReview(productId, formEl) {
  const data = new FormData(formEl);
  const rating = parseInt(data.get('rating'), 10);
  if (!rating) { showToast('Please select a rating'); return; }
  const body = { name: (data.get('name') || '').trim(), rating, comment: (data.get('comment') || '').trim() };
  try {
    await api('/api/products/' + productId + '/reviews', { method: 'POST', body });
    const [reviews, products] = await Promise.all([api('/api/products/' + productId + '/reviews'), api('/api/products')]);
    state.reviewsCache[productId] = reviews;
    state.products = products;
    showToast('Thanks for your review!');
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Admin auth ---------------- */
async function handleAuthSubmit(formEl) {
  const data = new FormData(formEl);
  const username = (data.get('username') || '').trim();
  const password = (data.get('password') || '').trim();
  if (!username || !password) { showToast('Enter a username and password'); return; }
  state.authError = '';
  try {
    if (!state.hasAdmin) {
      const setupKey = (data.get('setupKey') || '').trim();
      await api('/api/admin/setup', { method: 'POST', body: { username, password, setupKey } });
      state.hasAdmin = true;
    } else {
      await api('/api/admin/login', { method: 'POST', body: { username, password } });
    }
    state.isAdmin = true;
    state.adminUsername = username;
    state.view = 'admin';
    await loadAdminData();
    render();
  } catch (e) {
    state.authError = e.message;
    render();
  }
}
async function logout() {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch (e) {}
  state.isAdmin = false;
  state.adminUsername = null;
  state.view = 'store';
  render();
}
async function loadAdminData() {
  // Orders are managed in QuiverCRM now; nothing to preload for the dashboard.
}

/* ---------- Admin: admin accounts (up to two) ---------- */
async function switchAdminTab(tab) {
  state.adminTab = tab;
  render();
  if (tab === 'admins') {
    try {
      state.adminAccounts = await api('/api/admin/admins');
      render();
    } catch (e) { showToast(e.message); }
  }
}
async function addAdminAccount(formEl) {
  const data = new FormData(formEl);
  const username = (data.get('username') || '').trim();
  const password = (data.get('password') || '').trim();
  if (!username || !password) { showToast('Enter a username and password'); return; }
  try {
    await api('/api/admin/admins', { method: 'POST', body: { username, password } });
    formEl.reset();
    showToast('Admin added');
    state.adminAccounts = await api('/api/admin/admins');
    render();
  } catch (e) { showToast(e.message); }
}
async function deleteAdminAccount(username) {
  if (!confirm(`Remove admin "${username}"?`)) return;
  try {
    await api('/api/admin/admins/' + encodeURIComponent(username), { method: 'DELETE' });
    showToast('Admin removed');
    state.adminAccounts = await api('/api/admin/admins');
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Admin: settings & stock ---------------- */
async function saveSettingsForm(formEl) {
  const data = new FormData(formEl);
  try {
    state.settings = await api('/api/admin/settings', {
      method: 'PUT',
      body: {
        storeName: (data.get('storeName') || '').trim(),
        tagline: (data.get('tagline') || '').trim(),
        currency: (data.get('currency') || '').trim() || 'ZMW',
        whatsappNumber: (data.get('whatsappNumber') || '').trim(),
        supportPhone: (data.get('supportPhone') || '').trim(),
        contactEmail: (data.get('contactEmail') || '').trim(),
        storeAddress: (data.get('storeAddress') || '').trim(),
        facebookUrl: (data.get('facebookUrl') || '').trim(),
        instagramUrl: (data.get('instagramUrl') || '').trim(),
        tiktokUrl: (data.get('tiktokUrl') || '').trim(),
        aboutText: (data.get('aboutText') || '').trim(),
      },
    });
    document.title = state.settings.storeName || 'Online Store';
    showToast('Store details saved');
    render();
  } catch (e) { showToast(e.message); }
}
function startNewProduct() { state.editingProductId = 'new'; render(); }
function startEditProduct(id) { state.editingProductId = id; render(); }
function cancelEditProduct() { state.editingProductId = null; render(); }
async function saveProductForm(formEl) {
  const data = new FormData(formEl);
  const body = {
    name: (data.get('name') || '').trim(),
    category: (data.get('category') || '').trim(),
    price: parseFloat(data.get('price')),
    qty: parseInt(data.get('qty'), 10),
    emoji: (data.get('emoji') || '').trim() || '📦',
    description: (data.get('description') || '').trim(),
    imageUrl: (data.get('imageUrl') || '').trim(),
    discountQty: (data.get('discountQty') || '').trim(),
    discountPrice: (data.get('discountPrice') || '').trim(),
  };
  if (!body.name || !body.category || isNaN(body.price) || body.price < 0 || isNaN(body.qty) || body.qty < 0) {
    showToast('Fill in a valid name, category, price and quantity'); return;
  }
  if (Boolean(body.discountQty) !== Boolean(body.discountPrice)) {
    showToast('Set both a discount quantity and a discount price, or leave both blank'); return;
  }
  try {
    let savedProduct;
    if (state.editingProductId === 'new') {
      savedProduct = await api('/api/admin/products', { method: 'POST', body });
      state.products.push(savedProduct);
      showToast('Product added');
    } else {
      const updated = await api('/api/admin/products/' + state.editingProductId, { method: 'PUT', body });
      const idx = state.products.findIndex(p => p.id === updated.id);
      state.products[idx] = updated;
      savedProduct = updated;
      showToast('Product updated');
    }
    const imageFile = formEl.querySelector('[name="image"]')?.files?.[0];
    if (imageFile) {
      const fd = new FormData();
      fd.append('image', imageFile);
      const uploaded = await fetch('/api/admin/products/' + savedProduct.id + '/image', {
        method: 'POST', credentials: 'include', body: fd
      });
      const uploadData = await uploaded.json();
      if (!uploaded.ok) throw new Error(uploadData.error || 'Image upload failed');
      const idx = state.products.findIndex(p => p.id === uploadData.id);
      if (idx >= 0) state.products[idx] = uploadData;
    }
    state.editingProductId = null;
    render();
  } catch (e) { showToast(e.message); }
}
function copyAdLink(id) {
  const url = window.location.origin + '/p/' + id;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(url).then(
      () => showToast('Ad link copied — paste it into your Facebook ad'),
      () => window.prompt('Copy this link:', url)
    );
  } else {
    window.prompt('Copy this link:', url);
  }
}
async function deleteProduct(id) {
  if (!confirm('Remove this product from the store?')) return;
  try {
    await api('/api/admin/products/' + id, { method: 'DELETE' });
    state.products = state.products.filter(p => p.id !== id);
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------- Admin: services ---------- */
function startNewService() { state.editingServiceId = 'new'; render(); }
function startEditService(id) { state.editingServiceId = id; render(); }
function cancelEditService() { state.editingServiceId = null; render(); }
async function saveServiceForm(formEl) {
  const data = new FormData(formEl);
  const body = { title: (data.get('title') || '').trim(), description: (data.get('description') || '').trim() };
  if (!body.title) { showToast('Service title is required'); return; }
  try {
    if (state.editingServiceId === 'new') {
      const svc = await api('/api/admin/services', { method: 'POST', body });
      state.services.push(svc);
      showToast('Service added');
    } else {
      const updated = await api('/api/admin/services/' + state.editingServiceId, { method: 'PUT', body });
      const idx = state.services.findIndex(s => s.id === updated.id);
      state.services[idx] = updated;
      showToast('Service updated');
    }
    state.editingServiceId = null;
    render();
  } catch (e) { showToast(e.message); }
}
async function deleteService(id) {
  if (!confirm('Remove this service?')) return;
  try {
    await api('/api/admin/services/' + id, { method: 'DELETE' });
    state.services = state.services.filter(s => s.id !== id);
    render();
  } catch (e) { showToast(e.message); }
}

/* ---------------- Render ---------------- */
function render() {
  const app = document.getElementById('app');
  // Preserve focus/cursor across full-innerHTML re-renders (e.g. typing in
  // the search box triggers a render on every keystroke).
  const active = document.activeElement;
  const focusInfo = (active && active.id && app.contains(active))
    ? { id: active.id, start: active.selectionStart, end: active.selectionEnd }
    : null;

  if (state.loading) { app.innerHTML = skeletonStoreHtml(); return; }
  if (state.view === 'store') renderStore(app);
  else if (state.view === 'confirm') renderConfirm(app);
  else if (state.view === 'checkout') renderCheckout(app);
  else if (state.view === 'policy') renderPolicy(app);
  else if (state.view === 'product') renderProduct(app);
  else if (state.view === 'admin-auth') renderAuth(app);
  else if (state.view === 'admin') renderAdmin(app);
  else if (state.view === 'about') renderAbout(app);
  else if (state.view === 'services') renderServicesPage(app);
  else if (state.view === 'contacts') renderContacts(app);

  if (focusInfo) {
    const el = document.getElementById(focusInfo.id);
    if (el && typeof el.focus === 'function') {
      el.focus();
      if (typeof el.setSelectionRange === 'function' && focusInfo.start != null) {
        try { el.setSelectionRange(focusInfo.start, focusInfo.end); } catch (e) {}
      }
    }
  }
}

function topbar() {
  return `
  <div class="topbar">
    <button class="hamburger" onclick="state.navOpen = !state.navOpen; render();" aria-label="Menu">☰</button>
    <p class="brand">${escapeHtml(state.settings.storeName)}</p>
    <div class="topbar-right">
      ${state.isAdmin
        ? `<a class="icon-link" href="#" onclick="event.preventDefault(); state.view='admin'; render();">Dashboard</a><a class="icon-link" href="#" onclick="event.preventDefault(); logout();">Log out</a>`
        : `<a class="icon-link" href="#" onclick="event.preventDefault(); state.view='admin-auth'; render();">Store login</a>`}
    </div>
  </div>
  ${navDrawer()}`;
}

function navDrawer() {
  const link = (view, label) => `<a href="#" class="${state.view===view?'active':''}" onclick="event.preventDefault(); state.view='${view}'; state.navOpen=false; render();">${label}</a>`;
  return `
  <div class="nav-backdrop ${state.navOpen?'open':''}" onclick="state.navOpen=false; render();"></div>
  <div class="nav-drawer ${state.navOpen?'open':''}">
    <div class="nav-drawer-head">
      <p class="brand" style="color:var(--ink);">${escapeHtml(state.settings.storeName)}<small style="color:var(--ink-soft);">${escapeHtml(state.settings.tagline)}</small></p>
      <button class="close-x" onclick="state.navOpen=false; render();">✕</button>
    </div>
    <nav class="nav-drawer-links">
      ${link('store', '🏬 Shop')}
      ${link('about', 'ℹ️ About')}
      ${link('services', '🛠️ Services')}
      ${link('contacts', '✉️ Contacts')}
      ${link('policy', '📜 Policy & Agreement')}
    </nav>
  </div>`;
}

function socialLinksHtml() {
  const links = [
    ['Facebook', state.settings.facebookUrl, 'Facebook'],
    ['Instagram', state.settings.instagramUrl, 'Instagram'],
    ['TikTok', state.settings.tiktokUrl, 'TikTok'],
  ].filter(x => x[1]);
  if (!links.length) return '';
  return '<div class="social-links">' + links.map(([label, url]) =>
    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${label}">${label}</a>`
  ).join('') + '</div>';
}

function storeHero() {
  const inStockCount = state.products.filter(p => p.qty > 0).length;
  return `
  <div class="store-hero">
    <div class="store-hero-copy">
      <span class="eyebrow">Shop online · Pay on delivery</span>
      <h1>${escapeHtml(state.settings.storeName)}</h1>
      <p>${escapeHtml(state.settings.tagline)}</p>
      <div class="hero-actions">
        <button class="btn hero-primary" onclick="document.getElementById('search-input')?.scrollIntoView({behavior:'smooth', block:'center'}); document.getElementById('search-input')?.focus();">Start shopping</button>
        <a class="btn hero-secondary" href="#" onclick="event.preventDefault(); state.view='services'; render();">Our services</a>
      </div>
    </div>
    <div class="store-hero-art">
      <div class="hero-orb hero-orb-one"></div>
      <div class="hero-orb hero-orb-two"></div>
      <div class="hero-card">
        <span>IN STOCK NOW</span>
        <strong>${inStockCount}+</strong>
        <small>Products ready to order</small>
      </div>
    </div>
  </div>
  <div class="trust-strip">
    <div><div class="trust-icon">💵</div><div><strong>Pay on delivery</strong><small>Cash or bank transfer</small></div></div>
    <div><div class="trust-icon">🚚</div><div><strong>Nationwide delivery</strong><small>All 10 provinces of Zambia</small></div></div>
    <div><div class="trust-icon">💬</div><div><strong>WhatsApp support</strong><small>${escapeHtml(state.settings.supportPhone || '+260779173957')}</small></div></div>
    <div><div class="trust-icon">⭐</div><div><strong>Verified reviews</strong><small>From real customers</small></div></div>
  </div>`;
}

function renderStore(app) {
  const products = visibleProducts();
  app.innerHTML = `
    ${topbar()}
    <div class="wrap">
      ${storeHero()}
      <div class="search-bar">
        <input id="search-input" type="text" placeholder="Search products..." value="${escapeHtml(state.searchQuery)}"
          oninput="handleSearchInput(this.value)" onkeydown="if(event.key==='Enter'){event.preventDefault(); triggerSearch();}">
        <button class="btn search-btn" onclick="triggerSearch()" aria-label="Search">🔍</button>
      </div>
      <div class="filter-bar">
        <div class="category-pills">
          <button class="pill ${state.activeCategory==='All'?'active':''}" onclick="setCategory('All')">All</button>
          ${state.categories.map(c => `<button class="pill ${state.activeCategory===c?'active':''}" onclick="setCategory('${escapeHtml(c)}')">${escapeHtml(c)}</button>`).join('')}
        </div>
        <select class="sort-select" onchange="setSort(this.value)">
          <option value="best" ${state.sortBy==='best'?'selected':''}>Best Match</option>
          <option value="price-asc" ${state.sortBy==='price-asc'?'selected':''}>Price: Low to High</option>
          <option value="price-desc" ${state.sortBy==='price-desc'?'selected':''}>Price: High to Low</option>
        </select>
      </div>
      ${state.recommendations.length > 0 && !state.searchQuery && state.activeCategory === 'All' ? `
      <div class="section-head"><h2>Recommended for you</h2><span class="muted">Based on what you've browsed &amp; ordered</span></div>
      <div class="grid rec-row">${state.recommendations.map(productCard).join('')}</div>
      ` : ''}
      <div class="section-head"><h2>${state.activeCategory === 'All' ? 'Available stock' : escapeHtml(state.activeCategory)}</h2><span class="muted">${products.length} item${products.length===1?'':'s'}</span></div>
      ${products.length === 0 ? emptyStateHtml('🔍', 'No products match your search', 'Try a different keyword or browse all categories instead.') : `<div class="grid">${products.map(productCard).join('')}</div>`}
    </div>
    <footer>
      <div class="footer-contact"><strong>For inquiries call or send a WhatsApp message to ${escapeHtml(state.settings.supportPhone || '+260779173957')}</strong></div>
      <div class="footer-social">${socialLinksHtml()}</div>
      <div class="footer-note">Orders are confirmed by phone. Payment is on delivery.</div>
    </footer>
    ${reviewsPanel()}
    ${toastHtml()}
  `;
}

function productCard(p) {
  const out = p.qty <= 0;
  const low = !out && p.qty <= 3;
  return `
  <div class="card product-card">
    <button class="product-open" onclick="openProduct('${escapeHtml(p.id)}')" aria-label="View details for ${escapeHtml(p.name)}">
      <div class="swatch">${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" loading="lazy">` : (p.emoji || '📦')}</div>
      <div class="card-body">
        <span class="cat-badge">${escapeHtml(p.category || '')}</span>
        <h3>${escapeHtml(p.name)}</h3>
        <div class="desc">${escapeHtml(p.description || '')}</div>
        <span class="detail-link">View product details →</span>
      </div>
    </button>
    <div class="card-body product-actions">
      <button class="link-btn" onclick="openReviews('${escapeHtml(p.id)}')">${p.reviewCount ? '★ ' + p.avgRating + ' (' + p.reviewCount + ')' : 'No reviews yet'}</button>
      <div class="price-row"><span class="price">${money(p.price)}</span></div>
      ${discountBadgeHtml(p)}
      <span class="stock-note ${out?'out':low?'low':''}">${out ? 'Out of stock' : low ? p.qty + ' left' : p.qty + ' in stock'}</span>
      ${out ? `<button class="btn full" disabled>Out of stock</button>` : `<button class="btn full" onclick="startOrder('${escapeHtml(p.id)}')">Order Now</button>`}
    </div>
  </div>`;
}

function renderProduct(app) {
  const p = state.products.find(x => x.id === state.selectedProductId);
  if (!p) { state.view = 'store'; state.selectedProductId = null; renderStore(app); return; }
  const out = p.qty <= 0;
  const low = !out && p.qty <= 3;
  const reviews = state.reviewsCache[p.id] || [];
  app.innerHTML = `
    ${topbar()}
    <div class="wrap">
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <a href="#" onclick="event.preventDefault(); state.view='store'; state.activeCategory='All'; render();">Home</a>
        <span>/</span>
        ${p.category ? `<a href="#" onclick="event.preventDefault(); state.view='store'; setCategory('${escapeHtml(p.category)}');">${escapeHtml(p.category)}</a><span>/</span>` : ''}
        <span class="breadcrumb-current">${escapeHtml(p.name)}</span>
      </nav>
      <button class="btn ghost" onclick="closeProduct()">← Back to store</button>
      <div class="product-detail panel">
        <div class="product-detail-media">
          ${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}">` : `<div class="product-detail-emoji">${p.emoji || '📦'}</div>`}
        </div>
        <div class="product-detail-info">
          <span class="cat-badge">${escapeHtml(p.category || '')}</span>
          <h1>${escapeHtml(p.name)}</h1>
          <div class="product-detail-price">${money(p.price)}</div>
          ${discountBadgeHtml(p)}
          <div class="product-detail-stock ${out?'out':low?'low':''}">${out ? 'Out of stock' : low ? `${p.qty} left in stock` : `${p.qty} in stock`}</div>
          <h3>Product information</h3>
          <div class="product-detail-description">${escapeHtml(p.description || 'No additional product information has been provided yet.')}</div>
          <div class="product-detail-actions">
            ${out ? `<button class="btn full" disabled>Out of stock</button>` : `<button class="btn full" onclick="startOrder('${escapeHtml(p.id)}')">Order Now</button>`}
          </div>
        </div>
      </div>
      <div class="panel product-reviews-detail">
        <div class="section-head"><h2>Customer reviews</h2><button class="btn ghost" onclick="openReviews('${escapeHtml(p.id)}')">${p.reviewCount ? 'Read / write reviews' : 'Write a review'}</button></div>
        ${p.reviewCount ? `<p class="rating-summary">★ ${escapeHtml(p.avgRating)} / 5 · ${p.reviewCount} review${p.reviewCount === 1 ? '' : 's'}</p>` : `<p class="muted">No reviews yet. Be the first to review this product.</p>`}
        ${reviews.length ? `<div class="review-list">${reviews.slice(0,3).map(r => `<div class="review-item"><strong>${escapeHtml(r.name || 'Customer')}</strong><span>★ ${escapeHtml(r.rating)}</span><p>${escapeHtml(r.comment || '')}</p></div>`).join('')}</div>` : ''}
      </div>
    </div>
    <footer>
      <div class="footer-contact"><strong>For inquiries call or send a WhatsApp message to ${escapeHtml(state.settings.supportPhone || '+260779173957')}</strong></div>
      <div class="footer-social">${socialLinksHtml()}</div>
      <div class="footer-note">Orders are confirmed by phone — pay by cash or bank transfer on delivery.</div>
    </footer>
    ${toastHtml()}
  `;
}

function renderCheckout(app) {
  const p = state.products.find(x => x.id === state.orderDraft.productId);
  const availableStock = p ? Number(p.qty) : 0;
  if (!p || !Number.isInteger(availableStock) || availableStock <= 0) { cancelOrder(); return; }
  const qty = Math.max(1, Math.min(availableStock, Number(state.orderDraft.qty) || 1));
  state.orderDraft.qty = qty;
  const total = unitPriceFor(p, qty) * qty;
  app.innerHTML = `
    ${topbar()}
    <div class="wrap">
      <div class="checkout-page">
        <button class="btn ghost" onclick="cancelOrder()">← Back to store</button>
        <div class="section-head"><div><h2>Order Now</h2><span class="muted">Enter your quantity and delivery details to complete your order.</span></div></div>
        <div class="checkout-layout">
          <div class="panel order-summary-card">
            <div class="checkout-product">
              <div class="checkout-product-image">${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}">` : `<span>${p.emoji || '📦'}</span>`}</div>
              <div><span class="cat-badge">${escapeHtml(p.category || '')}</span><h3>${escapeHtml(p.name)}</h3><div class="price">${money(p.price)}</div>${discountBadgeHtml(p)}</div>
            </div>
            <div class="field"><label for="order-qty">Quantity</label><div class="qty-selector"><button type="button" id="order-qty-minus" onclick="adjustOrderQty(-1)" ${qty <= 1 ? 'disabled' : ''}>−</button><input id="order-qty" type="number" min="1" max="${availableStock}" value="${qty}" onchange="setOrderQty(this.value)"><button type="button" id="order-qty-plus" onclick="adjustOrderQty(1)" ${qty >= availableStock ? 'disabled' : ''}>+</button></div><small class="muted">${availableStock} available</small></div>
            <div class="total-row checkout-total"><span>Total</span><span id="order-total">${money(total)}</span></div>
            <div class="payment-note"><strong>Payment is on delivery.</strong><br>We will contact you by phone to confirm the order and delivery.</div>
          </div>
          <div class="panel">
            <h3>Customer & delivery details</h3>
            <form id="checkout-form" onsubmit="event.preventDefault(); submitOrder(this);">
              <div class="field"><label>Full name</label><input name="name" autocomplete="name" required></div>
              <div class="field"><label>Phone number</label><input name="phone" type="tel" autocomplete="tel" required></div>
              <div class="field"><label>Alternate phone (optional)</label><input name="altPhone" type="tel"></div>
              <div class="field"><label>Email address (optional)</label><input name="email" type="email" autocomplete="email" placeholder="you@example.com"></div>
              <div class="form-grid">
                <div class="field"><label>Town</label><input name="town" required></div>
                <div class="field"><label>Province</label><select name="province" required><option value="">Select province</option>${state.provinces.map(x => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('')}</select></div>
              </div>
              <div class="field"><label>Delivery address (plot/street)</label><textarea name="address" required></textarea></div>
              <div class="form-grid">
                <div class="field"><label>Preferred delivery date (optional)</label><input name="deliveryDate" type="date"></div>
                <div class="field"><label>Preferred time (optional)</label><select name="deliveryWindow"><option value="">No preference</option>${state.deliveryWindows.map(w => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`).join('')}</select></div>
              </div>
              <div class="field"><label>Notes (optional)</label><textarea name="notes" placeholder="Any delivery instructions?" ></textarea></div>
              <label class="agreement-check"><input type="checkbox" name="agreement" required> <span>I have read and agree to the <a href="#" onclick="event.preventDefault(); state.view='policy'; render();">${escapeHtml(state.settings.storeName)} Policy & Agreement</a>.</span></label>
              <button class="btn full checkout-submit" type="submit">Place Order — Pay on Delivery</button>
            </form>
          </div>
        </div>
      </div>
    </div>
    <footer><div class="footer-contact"><strong>For inquiries call or send a WhatsApp message to ${escapeHtml(state.settings.supportPhone || '+260779173957')}</strong></div><div class="footer-social">${socialLinksHtml()}</div><div class="footer-note">Payment is on delivery.</div></footer>
    ${toastHtml()}`;
}

function renderPolicy(app) {
  app.innerHTML = `
    ${topbar()}
    <div class="wrap">
      <button class="btn ghost" onclick="state.view='store'; render();">← Back to store</button>
      <div class="panel policy-page">
        <h1>${escapeHtml(state.settings.storeName)} Policy & Agreement</h1>
        <p class="muted">Please read this information before placing an order. By placing an order, you confirm that you understand and agree to these store terms.</p>

        <h3>1. Ordering</h3>
        <p>When you click <strong>Order Now</strong>, you select the product quantity and provide your contact and delivery information. Submitting an order is a request to purchase the selected product; ${escapeHtml(state.settings.storeName)} will contact you to confirm the order and delivery details.</p>

        <h3>2. Product availability and pricing</h3>
        <p>Products are subject to stock availability. Prices displayed on the store are in Zambian Kwacha (ZMW) unless otherwise stated. If a stock or pricing issue is identified before confirmation, we will contact you before proceeding.</p>

        <h3>3. Payment</h3>
        <p><strong>Payment is on delivery.</strong> Customers should pay only after the order is delivered and the agreed delivery details have been confirmed. The store may accept cash or another payment method communicated during order confirmation.</p>

        <h3>4. Delivery</h3>
        <p>Customers must provide a valid phone number, town, province and delivery address. Delivery timing may depend on location, product availability, rider availability and the preferred delivery window. A customer may be contacted to clarify directions or arrange a suitable delivery time.</p>

        <h3>5. Order confirmation and cancellation</h3>
        <p>Orders are confirmed by phone. If we cannot reach you or the details provided are incomplete, delivery may be delayed or the order may not be processed. Customers should contact ${escapeHtml(state.settings.storeName)} as soon as possible if they need to cancel or change an order before delivery.</p>

        <h3>6. Returns, exchanges and damaged items</h3>
        <p>Customers should inspect products at delivery and report any visible damage, missing item or incorrect product promptly. Returns or exchanges depend on the condition of the product and the circumstances of the issue. Contact ${escapeHtml(state.settings.storeName)} before returning an item so that the appropriate resolution can be agreed.</p>

        <h3>7. Customer information</h3>
        <p>Information submitted during checkout, such as your name, phone number, email address and delivery details, is used to process, confirm and deliver your order and to provide customer support. Customers should provide accurate information and should not submit another person's information without permission.</p>

        <h3>8. Customer responsibility</h3>
        <p>By placing an order, you confirm that the information you provide is accurate, that you are authorized to receive the order at the stated address, and that you will be available or make suitable arrangements for delivery.</p>

        <h3>9. Agreement</h3>
        <p>By checking the agreement box during checkout and placing an order, you confirm that you have read and accepted this Policy & Agreement. ${escapeHtml(state.settings.storeName)} may update these terms when necessary; the version displayed on the store at the time of your order applies to that order.</p>

        <div class="policy-contact"><strong>Questions?</strong><br>Call or send a WhatsApp message to ${escapeHtml(state.settings.supportPhone || '+260779173957')}.</div>
      </div>
    </div>
    <footer><div class="footer-contact"><strong>For inquiries call or send a WhatsApp message to ${escapeHtml(state.settings.supportPhone || '+260779173957')}</strong></div><div class="footer-social">${socialLinksHtml()}</div></footer>
    ${toastHtml()}`;
}


function reviewsPanel() {
  if (!state.reviewsOpenFor) return '';
  const product = state.products.find(p => p.id === state.reviewsOpenFor);
  const reviews = state.reviewsCache[state.reviewsOpenFor] || [];
  return `
  <div class="drawer-backdrop open" onclick="closeReviews()"></div>
  <div class="drawer open">
    <div class="drawer-head"><h3 style="margin:0;">Reviews${product ? ': ' + escapeHtml(product.name) : ''}</h3><button class="close-x" onclick="closeReviews()">✕</button></div>
    <div class="drawer-body">
      <form onsubmit="event.preventDefault(); submitReview('${state.reviewsOpenFor}', this);" style="margin-bottom:18px;">
        <div class="field"><label>Your name (optional)</label><input name="name" maxlength="60" placeholder="Anonymous"></div>
        <div class="field"><label>Rating</label>
          <select name="rating" required>
            <option value="">Select a rating...</option>
            ${[5,4,3,2,1].map(n => `<option value="${n}">${'★'.repeat(n)}${'☆'.repeat(5-n)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Comment (optional)</label><textarea name="comment" maxlength="800"></textarea></div>
        <button class="btn small" type="submit">Submit review</button>
      </form>
      ${reviews.length === 0 ? `<p class="muted">No reviews yet — be the first!</p>` : reviews.map(r => `
        <div class="review-item">
          <div class="review-head"><strong>${escapeHtml(r.name)}</strong><span>${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</span></div>
          ${r.comment ? `<p class="muted" style="margin:4px 0;">${escapeHtml(r.comment)}</p>` : ''}
          <span class="muted" style="font-size:11px;">${new Date(r.createdAt).toLocaleDateString()}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

function renderConfirm(app) {
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="panel" style="max-width:480px;margin:40px auto;text-align:center;">
      <h2>Order placed 🎉</h2>
      <p>Order <strong>${state.lastOrderId}</strong> has been received.</p>
      <p class="muted">We'll call you shortly to confirm delivery.</p>
      <p><strong>Payment is on delivery.</strong></p>
      ${state.lastOrderWhatsappUrl ? `<a class="btn" href="${escapeHtml(state.lastOrderWhatsappUrl)}" target="_blank" rel="noopener">For inquiries, send a message on WhatsApp: +260779173957</a>` : `<p class="muted">For inquiries, send a message on WhatsApp: +260779173957</p>`}
      <button class="btn ghost" onclick="state.view='store'; render();">Back to store</button>
    </div>
  </div>`;
}

function renderAbout(app) {
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="panel">
      <h2 style="margin-top:0;">About ${escapeHtml(state.settings.storeName)}</h2>
      <div class="about-copy">
        ${state.settings.aboutText
          ? `<p class="muted" style="white-space:pre-wrap;">${escapeHtml(state.settings.aboutText)}</p>`
          : `<p>${escapeHtml(state.settings.storeName)} is a customer-focused online shop bringing together practical health products for <strong>Men and Women</strong>. We make shopping simpler by giving customers a convenient way to browse available products, place an order and arrange reliable delivery across Zambia.</p>
             <p>We believe good shopping is about more than a product on a screen. It is about clear information, fair value, responsive customer service and keeping our word from the moment an order is placed until it reaches the customer.</p>
             <h3>Our Mission</h3>
             <p>To make quality everyday products easier to access across Zambia through convenient online shopping, dependable service and customer-first delivery.</p>
             <h3>Our Core Values</h3>
             <ul>
               <li><strong>Customer First:</strong> We listen, respond and build around real customer needs.</li>
               <li><strong>Quality & Value:</strong> We aim to offer products that balance usefulness, quality and affordability.</li>
               <li><strong>Integrity:</strong> We communicate honestly about products, prices, availability and delivery.</li>
               <li><strong>Reliability:</strong> We work to make every order clear, confirmed and delivered as promised.</li>
               <li><strong>Continuous Improvement:</strong> We use customer feedback and experience to keep improving the store.</li>
             </ul>`}
      </div>
    </div>
  </div>
  ${toastHtml()}`;
}

function renderServicesPage(app) {
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="section-head"><h2>Our Services</h2></div>
    ${state.services.length === 0 ? emptyStateHtml('🛠️', 'No services listed yet', 'Check back soon — we\'re adding services regularly.') : state.services.map(s => `
      <div class="panel">
        <h3 style="margin-top:0;">${escapeHtml(s.title)}</h3>
        ${s.description ? `<p class="muted">${escapeHtml(s.description)}</p>` : ''}
      </div>`).join('')}
  </div>
  ${toastHtml()}`;
}

function renderContacts(app) {
  const s = state.settings;
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="section-head"><h2>Contact Us</h2></div>
    <div class="panel">
      <div class="contact-row"><span class="icon">📞</span><div><strong>${escapeHtml(s.supportPhone || '—')}</strong><div class="muted">Call or SMS</div></div></div>
      ${s.whatsappNumber ? `<div class="contact-row"><span class="icon">💬</span><div><a class="btn small" href="${escapeHtml(whatsappUrl())}" target="_blank" rel="noopener">Chat on WhatsApp</a></div></div>` : ''}
      ${s.contactEmail ? `<div class="contact-row"><span class="icon">✉️</span><div><a href="mailto:${escapeHtml(s.contactEmail)}">${escapeHtml(s.contactEmail)}</a></div></div>` : ''}
      ${s.storeAddress ? `<div class="contact-row"><span class="icon">📍</span><div>${escapeHtml(s.storeAddress)}</div></div>` : ''}
      ${socialLinksHtml() ? `<div class="contact-row"><span class="icon">🌐</span><div>${socialLinksHtml()}</div></div>` : ''}
    </div>
  </div>
  ${toastHtml()}`;
}

function renderAuth(app) {
  const needsSetup = !state.hasAdmin;
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="login-wrap">
      <h2>${needsSetup ? 'Set up your store login' : 'Store login'}</h2>
      ${needsSetup ? `<p class="muted">No admin account exists yet — create one now to manage stock and orders.</p>` : ''}
      <form onsubmit="event.preventDefault(); handleAuthSubmit(this);">
        ${needsSetup ? `<div class="field"><label>Private setup key</label><input name="setupKey" type="password" required autocomplete="off"><small class="muted">This key is set in your hosting environment and is not your login password.</small></div>` : ''}
        <div class="field"><label>Username</label><input name="username" required autocomplete="username"></div>
        <div class="field"><label>Password</label><input name="password" type="password" required minlength="${needsSetup?6:1}"></div>
        <button class="btn full" type="submit">${needsSetup ? 'Create account & log in' : 'Log in'}</button>
        ${state.authError ? `<p class="error-text">${escapeHtml(state.authError)}</p>` : ''}
      </form>
      <p class="muted" style="margin-top:12px;"><a href="#" onclick="event.preventDefault(); state.view='store'; render();">← Back to store</a></p>
    </div>
  </div>`;
}

function renderAdmin(app) {
  app.innerHTML = `
  ${topbar()}
  <div class="wrap">
    <div class="top-admin-bar"><h2 style="margin:0;">Dashboard</h2></div>
    <div class="tabbar">
      <button class="${state.adminTab==='stock'?'active':''}" onclick="switchAdminTab('stock')">Stock</button>
      <button class="${state.adminTab==='services'?'active':''}" onclick="switchAdminTab('services')">Services</button>
      <button class="${state.adminTab==='admins'?'active':''}" onclick="switchAdminTab('admins')">Admins</button>
    </div>
    ${state.adminTab === 'stock' ? renderStockTab() : ''}
    ${state.adminTab === 'services' ? renderServicesAdminTab() : ''}
    ${state.adminTab === 'admins' ? renderAdminsTab() : ''}
  </div>
  ${toastHtml()}`;
}

function renderStockTab() {
  const editing = state.editingProductId;
  const editingProduct = editing && editing !== 'new' ? state.products.find(p => p.id === editing) : null;
  return `
    <div class="panel">
      <h3 style="margin-top:0;">Store details</h3>
      <form onsubmit="event.preventDefault(); saveSettingsForm(this);">
        <div class="form-grid">
          <div class="field"><label>Store name</label><input name="storeName" value="${escapeHtml(state.settings.storeName)}"></div>
          <div class="field"><label>Tagline</label><input name="tagline" value="${escapeHtml(state.settings.tagline)}"></div>
          <div class="field"><label>Currency</label><input name="currency" value="${escapeHtml(state.settings.currency || 'ZMW')}" style="width:100px;"></div>
          <div class="field"><label>WhatsApp number</label><input name="whatsappNumber" value="${escapeHtml(state.settings.whatsappNumber || '260779173957')}" placeholder="260XXXXXXXXX"></div>
          <div class="field"><label>Support phone</label><input name="supportPhone" value="${escapeHtml(state.settings.supportPhone || '+260779173957')}"></div>
          <div class="field"><label>Contact email (optional)</label><input name="contactEmail" type="email" value="${escapeHtml(state.settings.contactEmail||'')}"></div>
          <div class="field"><label>Store address (optional)</label><input name="storeAddress" value="${escapeHtml(state.settings.storeAddress||'')}"></div>
          <div class="field"><label>Facebook URL (optional)</label><input name="facebookUrl" type="url" value="${escapeHtml(state.settings.facebookUrl||'')}" placeholder="https://facebook.com/..."></div>
          <div class="field"><label>Instagram URL (optional)</label><input name="instagramUrl" type="url" value="${escapeHtml(state.settings.instagramUrl||'')}" placeholder="https://instagram.com/..."></div>
          <div class="field"><label>TikTok URL (optional)</label><input name="tiktokUrl" type="url" value="${escapeHtml(state.settings.tiktokUrl||'')}" placeholder="https://tiktok.com/@..."></div>
        </div>
        <div class="field"><label>About text (shown on the About page)</label><textarea name="aboutText" placeholder="Tell customers who you are...">${escapeHtml(state.settings.aboutText||'')}</textarea></div>
        <button class="btn" type="submit">Save</button>
      </form>
    </div>
    <div class="section-head"><h2>Stock</h2><button class="btn" onclick="startNewProduct()">+ Add product</button></div>
    ${editing ? `
    <div class="panel">
      <h3 style="margin-top:0;">${editing==='new' ? 'New product' : 'Edit product'}</h3>
      <form onsubmit="event.preventDefault(); saveProductForm(this);">
        <div class="form-grid">
          <div class="field"><label>Name</label><input name="name" required value="${escapeHtml(editingProduct?.name||'')}"></div>
          <div class="field"><label>Category</label>
            <select name="category" required>
              <option value="">Select category</option>
              ${state.categories.map(c => `<option value="${escapeHtml(c)}" ${editingProduct?.category===c?'selected':''}>${escapeHtml(c)}</option>`).join('')}
            </select>
          </div>
          <div class="field"><label>Product photo</label><input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></div>
          <div class="field"><label>Image URL (optional)</label><input name="imageUrl" type="url" placeholder="https://..." value="${escapeHtml(editingProduct?.imageUrl||'')}"></div>
          <div class="field"><label>Emoji / icon fallback</label><input name="emoji" placeholder="📦" value="${escapeHtml(editingProduct?.emoji||'')}"></div>
          <div class="field"><label>Price</label><input name="price" type="number" step="0.01" min="0" required value="${editingProduct?.price ?? ''}"></div>
          <div class="field"><label>Quantity in stock</label><input name="qty" type="number" step="1" min="0" required value="${editingProduct?.qty ?? ''}"></div>
        </div>
        <div class="form-grid">
          <div class="field"><label>Bulk discount: order at least</label><input name="discountQty" type="number" step="1" min="2" placeholder="e.g. 2" value="${editingProduct?.discountQty ?? ''}"></div>
          <div class="field"><label>...at this price per unit</label><input name="discountPrice" type="number" step="0.01" min="0" placeholder="e.g. 45.00" value="${editingProduct?.discountPrice ?? ''}"></div>
        </div>
        <small class="muted">Optional. Leave both blank for no bulk discount. Fill in both to give a lower per-unit price once a customer orders that many or more.</small>
        <div class="field"><label>Description</label><textarea name="description">${escapeHtml(editingProduct?.description||'')}</textarea></div>
        <div class="row-actions">
          <button class="btn" type="submit">Save product</button>
          <button class="btn ghost" type="button" onclick="cancelEditProduct()">Cancel</button>
        </div>
      </form>
    </div>` : ''}
    ${state.products.length === 0 ? `<div class="empty-state">No products yet — add your first one above.</div>` : `
    <table>
      <thead><tr><th></th><th>Name</th><th>Category</th><th>Price</th><th>Qty</th><th></th></tr></thead>
      <tbody>
        ${state.products.map(p => `
        <tr>
          <td>${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="" style="width:48px;height:48px;object-fit:cover;border-radius:8px;">` : (p.emoji||'📦')}</td>
          <td>${escapeHtml(p.name)}</td>
          <td>${escapeHtml(p.category||'—')}</td>
          <td>${money(p.price)}${p.discountQty ? `<br><small class="muted">${p.discountQty}+ at ${money(p.discountPrice)}</small>` : ''}</td>
          <td>${p.qty <= 0 ? '<span class="badge cancelled">Out</span>' : p.qty<=3 ? '<span class="badge new">'+p.qty+' low</span>' : p.qty}</td>
          <td class="row-actions">
            <button class="btn small ghost" onclick="startEditProduct('${p.id}')">Edit</button>
            <button class="btn small ghost" onclick="copyAdLink('${p.id}')">Ad link</button>
            <button class="btn small alert" onclick="deleteProduct('${p.id}')">Remove</button>
          </td>
        </tr>`).join('')}
      </tbody>
    </table>`}
  `;
}

function renderServicesAdminTab() {
  const editing = state.editingServiceId;
  const editingService = editing && editing !== 'new' ? state.services.find(s => s.id === editing) : null;
  return `
    <div class="section-head"><h2>Services</h2><button class="btn" onclick="startNewService()">+ Add service</button></div>
    ${editing ? `
    <div class="panel">
      <h3 style="margin-top:0;">${editing==='new' ? 'New service' : 'Edit service'}</h3>
      <form onsubmit="event.preventDefault(); saveServiceForm(this);">
        <div class="field"><label>Title</label><input name="title" required value="${escapeHtml(editingService?.title||'')}"></div>
        <div class="field"><label>Description</label><textarea name="description">${escapeHtml(editingService?.description||'')}</textarea></div>
        <div class="row-actions">
          <button class="btn" type="submit">Save</button>
          <button class="btn ghost" type="button" onclick="cancelEditService()">Cancel</button>
        </div>
      </form>
    </div>` : ''}
    ${state.services.length === 0 ? `<div class="empty-state">No services yet — add your first one above.</div>` : state.services.map(s => `
    <div class="panel">
      <div class="section-head">
        <div><h3 style="margin:0;">${escapeHtml(s.title)}</h3><span class="muted">${escapeHtml(s.description||'')}</span></div>
        <div class="row-actions">
          <button class="btn small ghost" onclick="startEditService('${s.id}')">Edit</button>
          <button class="btn small alert" onclick="deleteService('${s.id}')">Remove</button>
        </div>
      </div>
    </div>`).join('')}
  `;
}

function renderAdminsTab() {
  const accounts = state.adminAccounts || [];
  return `
    <div class="panel">
      <h3 style="margin-top:0;">Admin accounts</h3>
      <p class="muted">Up to 2 people can manage this dashboard. You're logged in as <strong>${escapeHtml(state.adminUsername || '')}</strong>.</p>
      ${accounts.length === 0 ? `<p class="muted">Loading…</p>` : `
      <table>
        <thead><tr><th>Username</th><th></th></tr></thead>
        <tbody>
          ${accounts.map(a => `
          <tr>
            <td>${escapeHtml(a.username)}${a.username === state.adminUsername ? ' <span class="muted">(you)</span>' : ''}</td>
            <td class="row-actions">${accounts.length > 1 ? `<button class="btn small alert" onclick="deleteAdminAccount('${escapeHtml(a.username)}')">Remove</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>
    ${accounts.length >= 2 ? `<p class="muted">Maximum of 2 admin accounts reached.</p>` : `
    <div class="panel">
      <h3 style="margin-top:0;">Add a second admin</h3>
      <form onsubmit="event.preventDefault(); addAdminAccount(this);">
        <div class="field"><label>Username</label><input name="username" required></div>
        <div class="field"><label>Password</label><input name="password" type="password" required minlength="10"></div>
        <button class="btn" type="submit">Add admin</button>
      </form>
    </div>`}
  `;
}

function toastHtml() { return state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ''; }
function emptyStateHtml(icon, title, subtitle) {
  return `<div class="empty-state"><div class="empty-state-icon">${icon}</div><h3>${escapeHtml(title)}</h3>${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ''}</div>`;
}
function skeletonStoreHtml() {
  const cards = Array.from({ length: 8 }).map(() => `
    <div class="card skeleton-card">
      <div class="skeleton-block swatch-h"></div>
      <div class="card-body">
        <div class="skeleton-block sk-line sk-line-cat"></div>
        <div class="skeleton-block sk-line sk-line-title"></div>
        <div class="skeleton-block sk-line sk-line-desc"></div>
        <div class="skeleton-block sk-line sk-line-price"></div>
      </div>
    </div>`).join('');
  return `
  <div class="wrap">
    <div class="skeleton-block skeleton-hero"></div>
    <div class="skeleton-block skeleton-bar" style="margin-bottom:14px;"></div>
    <div class="grid">${cards}</div>
  </div>`;
}
function escapeHtml(str) { return String(str ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

init();
