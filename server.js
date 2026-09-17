require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const store = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const SETUP_KEY = process.env.SETUP_KEY;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(process.env.DATA_DIR || __dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing/weak JWT_SECRET. Set a random secret of at least 32 characters.');
  process.exit(1);
}
if (!SETUP_KEY || SETUP_KEY.length < 12) {
  console.error('Missing/weak SETUP_KEY. Set a private setup key of at least 12 characters.');
  process.exit(1);
}

app.disable('x-powered-by');

// Render (and most PaaS hosts) sit behind a reverse proxy. Without this,
// req.ip is the proxy's IP (breaking per-customer rate limits) and
// req.protocol/req.secure don't reflect the real client scheme (breaking
// the absolute https:// URLs we build for Facebook ad-link previews below).
// "1" = trust exactly one hop, which matches Render's single edge proxy.
app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // The storefront renders HTML with inline event handlers (onclick/onsubmit),
  // so script-src (and the script-src-attr it falls back to) needs
  // 'unsafe-inline'. Everything else stays locked down instead of disabling
  // CSP outright, which would also drop clickjacking/base-uri/object-src
  // protection.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Please try again later.' } });
const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many setup attempts. Please try again later.' } });
const orderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many orders from this connection. Please try again later.' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));

const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, crypto.randomBytes(12).toString('hex') + ext);
  }
});
const upload = multer({
  storage: imageStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP and GIF images are allowed.'));
  }
});

function newId(prefix) { return prefix + '-' + crypto.randomBytes(5).toString('hex'); }
function cleanText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function normalizePhone(value) { return String(value ?? '').replace(/[^\d+]/g, '').slice(0, 20); }
function validMoney(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000000; }
function validQty(value) { return Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 1000000000; }
function escapeHtmlServer(str) { return String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

// Fixed category list. Kept as a simple constant (rather than admin-editable
// storage) since the person asked for exactly these four.
const CATEGORIES = ['Electronics', 'Health Products', 'Cosmetics', 'Clothes'];
const PROVINCES = ['Central', 'Copperbelt', 'Eastern', 'Luapula', 'Lusaka', 'Muchinga', 'Northern', 'North-Western', 'Southern', 'Western'];
const DELIVERY_WINDOWS = ['Morning (08:00–12:00)', 'Afternoon (12:00–16:00)', 'Evening (16:00–19:00)', 'Anytime'];
// Constant-time secret compare — see QuiverCRM's server.js for rationale.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/* ---------- Auth ---------- */
function requireAdmin(req, res, next) {
  const token = req.cookies.gw_token;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.clearCookie('gw_token', cookieOptions());
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
}
function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' };
}
function issueSession(res, username) {
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
  res.cookie('gw_token', token, cookieOptions());
}

app.get('/api/admin/status', (_req, res) => res.json({ hasAdmin: !!store.getData().admin }));

app.post('/api/admin/setup', setupLimiter, async (req, res) => {
  const data = store.getData();
  if (data.admin) return res.status(400).json({ error: 'Admin account already exists' });
  const { username, password, setupKey } = req.body || {};
  if (!setupKey || !safeEqual(setupKey, SETUP_KEY)) return res.status(403).json({ error: 'Invalid setup key' });
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(String(username || ''))) return res.status(400).json({ error: 'Username must be 3–40 letters, numbers, dots, dashes or underscores' });
  if (!password || String(password).length < 10) return res.status(400).json({ error: 'Use a password of at least 10 characters' });
  data.admin = { username: String(username), passwordHash: await bcrypt.hash(String(password), 12) };
  await store.save();
  issueSession(res, data.admin.username);
  res.json({ ok: true });
});

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const data = store.getData();
  const { username, password } = req.body || {};
  if (!data.admin) return res.status(400).json({ error: 'No admin account yet' });
  const ok = data.admin.username === username && await bcrypt.compare(String(password || ''), data.admin.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect username or password' });
  issueSession(res, username);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  res.clearCookie('gw_token', { httpOnly: true, sameSite: 'lax', secure: IS_PRODUCTION, path: '/' });
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ username: req.admin.username }));

/* ---------- Settings ---------- */
app.get('/api/settings', (_req, res) => {
  const { storeName, tagline, currency, whatsappNumber, supportPhone, aboutText, storeAddress, contactEmail, facebookUrl, instagramUrl, tiktokUrl } = store.getData().settings;
  res.json({ storeName, tagline, currency, whatsappNumber, supportPhone, aboutText, storeAddress, contactEmail, facebookUrl, instagramUrl, tiktokUrl });
});
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const data = store.getData();
  const { storeName, tagline, currency, whatsappNumber, supportPhone, aboutText, storeAddress, contactEmail, facebookUrl, instagramUrl, tiktokUrl } = req.body || {};
  if (storeName !== undefined) data.settings.storeName = cleanText(storeName, 80) || 'Godwyn Stores';
  if (tagline !== undefined) data.settings.tagline = cleanText(tagline, 160);
  if (currency !== undefined) data.settings.currency = cleanText(currency, 10) || 'ZMW';
  if (whatsappNumber !== undefined) data.settings.whatsappNumber = String(whatsappNumber).replace(/\D/g, '').slice(0, 20);
  if (supportPhone !== undefined) data.settings.supportPhone = cleanText(supportPhone, 30);
  if (aboutText !== undefined) data.settings.aboutText = cleanText(aboutText, 4000);
  if (storeAddress !== undefined) data.settings.storeAddress = cleanText(storeAddress, 300);
  if (contactEmail !== undefined) data.settings.contactEmail = cleanText(contactEmail, 120);
  if (facebookUrl !== undefined) data.settings.facebookUrl = cleanText(facebookUrl, 300);
  if (instagramUrl !== undefined) data.settings.instagramUrl = cleanText(instagramUrl, 300);
  if (tiktokUrl !== undefined) data.settings.tiktokUrl = cleanText(tiktokUrl, 300);
  await store.save();
  res.json(data.settings);
});

app.get('/api/categories', (_req, res) => res.json(CATEGORIES));
app.get('/api/provinces', (_req, res) => res.json(PROVINCES));
app.get('/api/delivery-windows', (_req, res) => res.json(DELIVERY_WINDOWS));

/* ---------- Products ---------- */
function withRatings(product, reviews) {
  const productReviews = reviews.filter(r => r.productId === product.id);
  const reviewCount = productReviews.length;
  const avgRating = reviewCount ? productReviews.reduce((s, r) => s + r.rating, 0) / reviewCount : 0;
  return { ...product, avgRating: Math.round(avgRating * 10) / 10, reviewCount };
}
app.get('/api/products', (req, res) => {
  const data = store.getData();
  let products = data.products.map(p => withRatings(p, data.reviews));
  const { category, search } = req.query || {};
  if (category && CATEGORIES.includes(category)) products = products.filter(p => p.category === category);
  if (search) {
    const q = String(search).trim().toLowerCase().slice(0, 100);
    if (q) products = products.filter(p => p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q));
  }
  res.json(products);
});

function validateProductInput(body, partial = false) {
  const out = {};
  if (!partial || body.name !== undefined) {
    out.name = cleanText(body.name, 100);
    if (!out.name) throw new Error('Product name is required');
  }
  if (!partial || body.price !== undefined) {
    if (!validMoney(body.price)) throw new Error('Enter a valid price');
    out.price = Number(body.price);
  }
  if (!partial || body.qty !== undefined) {
    if (!validQty(body.qty)) throw new Error('Enter a valid stock quantity');
    out.qty = Number(body.qty);
  }
  if (!partial || body.category !== undefined) {
    if (!CATEGORIES.includes(body.category)) throw new Error('Choose a valid category: ' + CATEGORIES.join(', '));
    out.category = body.category;
  }
  if (body.emoji !== undefined) out.emoji = cleanText(body.emoji, 10) || '📦';
  if (body.description !== undefined) out.description = cleanText(body.description, 500);
  if (body.imageUrl !== undefined) out.imageUrl = cleanText(body.imageUrl, 1000);
  return out;
}

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const p = validateProductInput(req.body || {});
    const product = { id: newId('P'), ...p, emoji: p.emoji || '📦', description: p.description || '', imageUrl: p.imageUrl || '' };
    store.getData().products.push(product);
    await store.save();
    res.json(product);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const product = store.getData().products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  try {
    Object.assign(product, validateProductInput(req.body || {}, true));
    await store.save();
    res.json(product);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/admin/products/:id/image', requireAdmin, upload.single('image'), async (req, res) => {
  const product = store.getData().products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  if (!req.file) return res.status(400).json({ error: 'Choose an image first' });
  if (product.imageUrl && product.imageUrl.startsWith('/uploads/')) {
    const old = path.join(UPLOAD_DIR, path.basename(product.imageUrl));
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  product.imageUrl = '/uploads/' + req.file.filename;
  await store.save();
  res.json(product);
});

app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const data = store.getData();
  const product = data.products.find(p => p.id === req.params.id);
  if (product?.imageUrl?.startsWith('/uploads/')) {
    const file = path.join(UPLOAD_DIR, path.basename(product.imageUrl));
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  data.products = data.products.filter(p => p.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

/* ---------- Orders ---------- */
app.post('/api/orders', orderLimiter, async (req, res) => {
  const data = store.getData();
  const { items, customerName, phone, altPhone, email, town, province, address, deliveryDate, deliveryWindow, notes } = req.body || {};
  const name = cleanText(customerName, 100);
  const customerPhone = normalizePhone(phone);
  const customerAltPhone = normalizePhone(altPhone);
  const customerEmail = cleanText(email, 160);
  const customerTown = cleanText(town, 100);
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address or leave it blank' });
  }
  const customerProvince = PROVINCES.includes(province) ? province : '';
  const deliveryAddress = cleanText(address, 500);
  const orderNotes = cleanText(notes, 500);
  const window = DELIVERY_WINDOWS.includes(deliveryWindow) ? deliveryWindow : '';
  let deliveryDateClean = '';
  if (deliveryDate) {
    const parsed = new Date(deliveryDate);
    if (!isNaN(parsed.getTime())) deliveryDateClean = parsed.toISOString().slice(0, 10);
  }
  if (!Array.isArray(items) || items.length === 0 || items.length > 50 || !name || customerPhone.length < 7 || !customerTown || !customerProvince || !deliveryAddress) {
    return res.status(400).json({ error: 'Please provide valid name, phone, town, province, address and at least one item' });
  }

  const resolvedItems = [];
  const requested = new Map();
  for (const item of items) {
    const id = cleanText(item?.id, 100);
    const qty = Number(item?.qty);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 1000000000) return res.status(400).json({ error: 'Please enter a valid order quantity (a whole number greater than 0).' });
    requested.set(id, (requested.get(id) || 0) + qty);
  }
  for (const [id, qty] of requested) {
    const product = data.products.find(p => p.id === id);
    if (!product) return res.status(400).json({ error: 'The selected product no longer exists' });
    const availableStock = Number(product.qty);
    if (!Number.isInteger(availableStock) || availableStock < 0) return res.status(400).json({ error: `"${product.name}" has an invalid stock quantity. Please contact Godwyn Stores.` });
    if (availableStock < qty) return res.status(400).json({ error: `Only ${availableStock} unit${availableStock === 1 ? '' : 's'} of "${product.name}" ${availableStock === 1 ? 'is' : 'are'} currently available` });
    resolvedItems.push({ id: product.id, name: product.name, category: product.category, price: Number(product.price), qty, subtotal: Number(product.price) * qty });
  }

  resolvedItems.forEach(item => { data.products.find(p => p.id === item.id).qty -= item.qty; });
  const total = resolvedItems.reduce((sum, i) => sum + i.qty * i.price, 0);
  const order = {
    id: newId('ORD'), items: resolvedItems, total,
    customerName: name, phone: customerPhone, altPhone: customerAltPhone, email: customerEmail,
    town: customerTown, province: customerProvince, address: deliveryAddress,
    deliveryDate: deliveryDateClean, deliveryWindow: window,
    notes: orderNotes, status: 'new', createdAt: new Date().toISOString(),
  };
  data.orders.unshift(order);
  await store.save();

  const waNumber = String(data.settings.whatsappNumber || '').replace(/\D/g, '');
  const waMessage = encodeURIComponent(`Hello Godwyn Stores, I placed order ${order.id}. Total: ${data.settings.currency} ${total.toFixed(2)}. My name is ${name}. Delivery: ${customerTown}, ${customerProvince}${window ? ' (' + window + ')' : ''}.`);
  res.json({ orderId: order.id, whatsappUrl: waNumber ? `https://wa.me/${waNumber}?text=${waMessage}` : null });

  // Push the order into QuiverCRM (or any connected CRM) if configured.
  // Fire-and-forget: a slow/unreachable CRM must never delay or fail the
  // customer's checkout, which is why this happens after res.json() and
  // any error here is only logged, never thrown.
  if (process.env.CRM_WEBHOOK_URL && process.env.CRM_API_KEY) {
    if (typeof fetch !== 'function') {
      console.error('QuiverCRM sync failed: global fetch is unavailable — this Node runtime is older than 18. Check your Node version.');
    } else {
      console.log(`QuiverCRM sync: sending order ${order.id} to ${process.env.CRM_WEBHOOK_URL}`);
      fetch(process.env.CRM_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-QuiverCRM-Key': process.env.CRM_API_KEY },
        body: JSON.stringify({
          source: 'Godwyn Stores',
          orderType: 'direct_order',
          paymentMethod: 'Pay on Delivery',
          externalId: order.id,
          items: order.items,
          total: order.total,
          currency: data.settings.currency,
          status: order.status,
          paymentStatus: 'pending',
          itemCount: order.items.reduce((sum, item) => sum + item.qty, 0),
          customerName: order.customerName,
          phone: order.phone,
          email: order.email,
          altPhone: order.altPhone,
          town: order.town,
          province: order.province,
          address: order.address,
          deliveryDate: order.deliveryDate,
          deliveryWindow: order.deliveryWindow,
          notes: order.notes,
          customer: {
            name: order.customerName, phone: order.phone, altPhone: order.altPhone, email: order.email,
            town: order.town, province: order.province, address: order.address,
          },
          delivery: { date: order.deliveryDate, window: order.deliveryWindow, notes: order.notes },
          itemsDetailed: order.items.map(item => ({ ...item, subtotal: item.price * item.qty })),
          createdAt: order.createdAt,
        }),
      }).then(async (resp) => {
        if (!resp.ok) {
          const body = await resp.text().catch(() => '');
          console.error(`QuiverCRM sync failed: HTTP ${resp.status} ${body}`);
        } else {
          console.log(`QuiverCRM sync: order ${order.id} accepted (HTTP ${resp.status})`);
        }
      }).catch(err => console.error('QuiverCRM sync failed:', err.message));
    }
  } else {
    console.log(`QuiverCRM sync: skipped — CRM_WEBHOOK_URL is ${process.env.CRM_WEBHOOK_URL ? 'set' : 'MISSING'}, CRM_API_KEY is ${process.env.CRM_API_KEY ? 'set' : 'MISSING'}`);
  }
});

app.get('/api/admin/orders', requireAdmin, (_req, res) => res.json(store.getData().orders));

/* ---------- Reviews ---------- */
const reviewLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many reviews submitted. Please try again later.' } });

app.get('/api/products/:id/reviews', (req, res) => {
  const reviews = store.getData().reviews.filter(r => r.productId === req.params.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(reviews);
});
app.post('/api/products/:id/reviews', reviewLimiter, async (req, res) => {
  const data = store.getData();
  const product = data.products.find(p => p.id === req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const { name, rating, comment } = req.body || {};
  const reviewerName = cleanText(name, 60) || 'Anonymous';
  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5' });
  const review = {
    id: newId('REV'), productId: product.id, name: reviewerName, rating: ratingNum,
    comment: cleanText(comment, 800), createdAt: new Date().toISOString(),
  };
  data.reviews.push(review);
  await store.save();
  res.json(review);
});
app.delete('/api/admin/reviews/:id', requireAdmin, async (req, res) => {
  const data = store.getData();
  data.reviews = data.reviews.filter(r => r.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

/* ---------- Services ---------- */
app.get('/api/services', (_req, res) => res.json(store.getData().services));
app.post('/api/admin/services', requireAdmin, async (req, res) => {
  const data = store.getData();
  const title = cleanText(req.body?.title, 100);
  if (!title) return res.status(400).json({ error: 'Service title is required' });
  const service = { id: newId('SVC'), title, description: cleanText(req.body?.description, 500) };
  data.services.push(service);
  await store.save();
  res.json(service);
});
app.put('/api/admin/services/:id', requireAdmin, async (req, res) => {
  const service = store.getData().services.find(s => s.id === req.params.id);
  if (!service) return res.status(404).json({ error: 'Service not found' });
  if (req.body?.title !== undefined) { const t = cleanText(req.body.title, 100); if (!t) return res.status(400).json({ error: 'Service title is required' }); service.title = t; }
  if (req.body?.description !== undefined) service.description = cleanText(req.body.description, 500);
  await store.save();
  res.json(service);
});
app.delete('/api/admin/services/:id', requireAdmin, async (req, res) => {
  const data = store.getData();
  data.services = data.services.filter(s => s.id !== req.params.id);
  await store.save();
  res.json({ ok: true });
});

/* ---------- Recommendations ----------
 * A lightweight, explainable recommendation engine — no external ML needed
 * for a catalog this size. Two real signals, both derived from actual order
 * history:
 *   1. "Frequently bought together" — for each item currently in the
 *      shopper's cart, count how often other products co-occurred with it
 *      across all past orders, and rank by that count.
 *   2. Category popularity — how many times products in the shopper's
 *      most-browsed category have actually sold, used both as a fallback
 *      and as a tiebreaker.
 * Cold start (a brand-new store with no orders yet) falls back to featured
 * in-stock products so the section is never empty.
 */
app.get('/api/recommendations', (req, res) => {
  const data = store.getData();
  const cartIds = String(req.query.cartIds || '').split(',').map(s => cleanText(s, 100)).filter(Boolean);
  const category = CATEGORIES.includes(req.query.category) ? req.query.category : null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 6, 1), 20);
  const exclude = new Set(cartIds);

  const inStock = data.products.filter(p => p.qty > 0);
  const byId = new Map(inStock.map(p => [p.id, p]));

  // Signal 1: co-purchase counts for items in the cart.
  const coCounts = new Map();
  if (cartIds.length) {
    for (const order of data.orders) {
      const orderItemIds = new Set(order.items.map(i => i.id));
      const hasCartItem = cartIds.some(id => orderItemIds.has(id));
      if (!hasCartItem) continue;
      for (const item of order.items) {
        if (exclude.has(item.id) || !byId.has(item.id)) continue;
        coCounts.set(item.id, (coCounts.get(item.id) || 0) + 1);
      }
    }
  }

  // Signal 2: sales count per product, and per category, from order history.
  const salesCount = new Map();
  for (const order of data.orders) {
    for (const item of order.items) {
      salesCount.set(item.id, (salesCount.get(item.id) || 0) + item.qty);
    }
  }

  const scored = inStock
    .filter(p => !exclude.has(p.id))
    .map(p => {
      let score = (coCounts.get(p.id) || 0) * 10; // co-purchase is the strongest signal
      score += (salesCount.get(p.id) || 0);        // general popularity
      if (category && p.category === category) score += 5; // affinity boost
      return { product: p, score };
    })
    .sort((a, b) => b.score - a.score || (b.product.qty - a.product.qty));

  const hasAnySignal = scored.some(s => s.score > 0);
  let results;
  if (hasAnySignal) {
    results = scored.slice(0, limit).map(s => s.product);
  } else {
    // Cold start: no order history yet to learn from. Show a reasonable
    // in-stock spread, preferring the browsed category if one was given.
    const preferred = category ? inStock.filter(p => p.category === category && !exclude.has(p.id)) : [];
    const rest = inStock.filter(p => !preferred.includes(p) && !exclude.has(p.id));
    results = [...preferred, ...rest].slice(0, limit);
  }
  res.json(results.map(p => withRatings(p, data.reviews)));
});

/* ---------- Shareable product page (Facebook / WhatsApp ad links) ----------
 * A plain server-rendered page per product with Open Graph tags, so that
 * pasting https://yourdomain/p/PRODUCT_ID into a Facebook ad, post, or
 * WhatsApp message shows the product's photo, name, description and price
 * as a rich link preview instead of a bare URL. Real visitors land on a
 * simple "buy this" page that sends them into the store or straight to
 * WhatsApp.
 */
app.get('/p/:id', (req, res) => {
  const data = store.getData();
  const product = data.products.find(p => p.id === req.params.id);
  if (!product) return res.redirect('/');

  const origin = `${req.protocol}://${req.get('host')}`;
  const pageUrl = `${origin}/p/${encodeURIComponent(product.id)}`;
  const absoluteImage = product.imageUrl
    ? (/^https?:\/\//i.test(product.imageUrl) ? product.imageUrl : origin + product.imageUrl)
    : null;
  const title = `${product.name} — ${data.settings.storeName}`;
  const description = product.description || data.settings.tagline || '';
  const priceLabel = `${data.settings.currency} ${Number(product.price).toFixed(2)}`;
  const waNumber = String(data.settings.whatsappNumber || '').replace(/\D/g, '');
  const waMessage = encodeURIComponent(`Hello ${data.settings.storeName}, I'm interested in "${product.name}" (${priceLabel}). Is it still available?`);
  const waLink = waNumber ? `https://wa.me/${waNumber}?text=${waMessage}` : null;
  const out = product.qty <= 0;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtmlServer(title)}</title>
<meta name="description" content="${escapeHtmlServer(description)}">
<link rel="canonical" href="${pageUrl}">

<meta property="og:type" content="product">
<meta property="og:title" content="${escapeHtmlServer(title)}">
<meta property="og:description" content="${escapeHtmlServer(description)}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:site_name" content="${escapeHtmlServer(data.settings.storeName)}">
${absoluteImage ? `<meta property="og:image" content="${escapeHtmlServer(absoluteImage)}">` : ''}
<meta property="product:price:amount" content="${product.price}">
<meta property="product:price:currency" content="${escapeHtmlServer(data.settings.currency || 'ZMW')}">
<meta name="twitter:card" content="${absoluteImage ? 'summary_large_image' : 'summary'}">

<link rel="stylesheet" href="/styles.css">
</head>
<body>
<div class="wrap" style="max-width:520px;margin:0 auto;padding-top:32px;">
  <div class="panel" style="text-align:center;">
    <div class="swatch" style="min-height:200px;">
      ${absoluteImage ? `<img src="${escapeHtmlServer(absoluteImage)}" alt="${escapeHtmlServer(product.name)}">` : (product.emoji || '📦')}
    </div>
    <h2 style="margin:16px 0 4px;">${escapeHtmlServer(product.name)}</h2>
    ${description ? `<p class="muted">${escapeHtmlServer(description)}</p>` : ''}
    <p class="price" style="font-size:22px;margin:8px 0;">${escapeHtmlServer(priceLabel)}</p>
    <p class="stock-note ${out ? 'out' : ''}">${out ? 'Out of stock' : (product.qty <= 3 ? product.qty + ' left in stock' : 'In stock')}</p>
    <a class="btn full" href="/" style="display:block;margin-top:12px;text-decoration:none;">Shop at ${escapeHtmlServer(data.settings.storeName)}</a>
    ${waLink ? `<a class="btn ghost full" href="${waLink}" target="_blank" rel="noopener" style="display:block;margin-top:8px;text-decoration:none;">Ask on WhatsApp</a>` : ''}
  </div>
</div>
</body>
</html>`);
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Image upload failed: ' + err.message });
  if (err?.message?.includes('Only JPG')) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

store.init()
  .then(() => app.listen(PORT, () => console.log(`Godwyn Stores running on http://localhost:${PORT}`)))
  .catch(err => { console.error('Failed to initialize datastore:', err.message); process.exit(1); });
