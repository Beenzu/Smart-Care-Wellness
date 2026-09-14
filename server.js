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
  const { storeName, tagline, currency, whatsappNumber, supportPhone } = store.getData().settings;
  res.json({ storeName, tagline, currency, whatsappNumber, supportPhone });
});
app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const data = store.getData();
  const { storeName, tagline, currency, whatsappNumber, supportPhone } = req.body || {};
  if (storeName !== undefined) data.settings.storeName = cleanText(storeName, 80) || 'Godwyn Stores';
  if (tagline !== undefined) data.settings.tagline = cleanText(tagline, 160);
  if (currency !== undefined) data.settings.currency = cleanText(currency, 10) || 'ZMW';
  if (whatsappNumber !== undefined) data.settings.whatsappNumber = String(whatsappNumber).replace(/\D/g, '').slice(0, 20);
  if (supportPhone !== undefined) data.settings.supportPhone = cleanText(supportPhone, 30);
  await store.save();
  res.json(data.settings);
});

/* ---------- Products ---------- */
app.get('/api/products', (_req, res) => res.json(store.getData().products));

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
  const { items, customerName, phone, address, notes } = req.body || {};
  const name = cleanText(customerName, 100);
  const customerPhone = normalizePhone(phone);
  const deliveryAddress = cleanText(address, 500);
  const orderNotes = cleanText(notes, 500);
  if (!Array.isArray(items) || items.length === 0 || items.length > 50 || !name || customerPhone.length < 7 || !deliveryAddress) {
    return res.status(400).json({ error: 'Please provide valid name, phone, address and at least one item' });
  }

  const resolvedItems = [];
  const requested = new Map();
  for (const item of items) {
    const id = cleanText(item?.id, 100);
    const qty = Number(item?.qty);
    if (!id || !Number.isInteger(qty) || qty < 1 || qty > 1000) return res.status(400).json({ error: 'Invalid cart item' });
    requested.set(id, (requested.get(id) || 0) + qty);
  }
  for (const [id, qty] of requested) {
    const product = data.products.find(p => p.id === id);
    if (!product) return res.status(400).json({ error: 'One of the items in your cart no longer exists' });
    if (product.qty < qty) return res.status(400).json({ error: `"${product.name}" no longer has enough stock` });
    resolvedItems.push({ id: product.id, name: product.name, price: product.price, qty });
  }

  resolvedItems.forEach(item => { data.products.find(p => p.id === item.id).qty -= item.qty; });
  const total = resolvedItems.reduce((sum, i) => sum + i.qty * i.price, 0);
  const order = { id: newId('ORD'), items: resolvedItems, total, customerName: name, phone: customerPhone, address: deliveryAddress, notes: orderNotes, status: 'new', createdAt: new Date().toISOString() };
  data.orders.unshift(order);

  let customer = data.customers.find(c => c.phone === customerPhone);
  if (customer) {
    customer.name = name; customer.address = deliveryAddress;
    customer.orderCount = (customer.orderCount || 0) + 1;
    customer.totalSpent = (customer.totalSpent || 0) + total;
    customer.lastOrderAt = order.createdAt;
  } else {
    data.customers.push({ phone: customerPhone, name, address: deliveryAddress, orderCount: 1, totalSpent: total, lastOrderAt: order.createdAt, crmNotes: '' });
  }
  await store.save();

  const waNumber = String(data.settings.whatsappNumber || '').replace(/\D/g, '');
  const waMessage = encodeURIComponent(`Hello Godwyn Stores, I placed order ${order.id}. Total: ${data.settings.currency} ${total.toFixed(2)}. My name is ${name}.`);
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
          externalId: order.id,
          items: order.items,
          total: order.total,
          currency: data.settings.currency,
          customerName: order.customerName,
          phone: order.phone,
          address: order.address,
          notes: order.notes,
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
app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const order = store.getData().orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { status } = req.body || {};
  if (!['new', 'contacted', 'delivered', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  order.status = status; await store.save(); res.json(order);
});

/* ---------- CRM ---------- */
app.get('/api/admin/customers', requireAdmin, (_req, res) => res.json(store.getData().customers));
app.patch('/api/admin/customers/:phone', requireAdmin, async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const customer = store.getData().customers.find(c => c.phone === phone);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (req.body?.crmNotes !== undefined) customer.crmNotes = cleanText(req.body.crmNotes, 1000);
  await store.save(); res.json(customer);
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
app.listen(PORT, () => console.log(`Godwyn Stores running on http://localhost:${PORT}`));
