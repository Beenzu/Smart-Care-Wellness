// Persistent datastore. Primary backend: Upstash Redis REST API (survives
// container restarts/redeploys on free hosting tiers, which don't support
// attached disks). Falls back to a local JSON file automatically when
// UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN aren't set, so this
// still works unmodified for local development.
const fs = require('fs');
const path = require('path');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
// Change this if you point multiple apps at the same Upstash database —
// each app needs its own key so they don't overwrite each other's data.
const REDIS_KEY = process.env.UPSTASH_DATA_KEY || 'godwyn:data';
const useUpstash = !!(UPSTASH_URL && UPSTASH_TOKEN);

const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_DATA = {
  admin: null, // legacy single-admin field, migrated into `admins` below on load
  admins: [],
  settings: {
    storeName: 'Online Store',
    tagline: 'Quality goods, delivered across Zambia.',
    currency: 'ZMW',
    whatsappNumber: '260779173957',
    supportPhone: '+260779173957',
    aboutText: '',
    storeAddress: '',
    contactEmail: '',
  },
  products: [],
  orders: [],
  reviews: [],
  services: [],
};

let data = JSON.parse(JSON.stringify(DEFAULT_DATA));
let writeQueue = Promise.resolve();

async function upstashCommand(args) {
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const json = await res.json();
  if (json.error) throw new Error('Upstash error: ' + json.error);
  return json.result;
}

async function loadFromUpstash() {
  const raw = await upstashCommand(['GET', REDIS_KEY]);
  if (!raw) {
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    await upstashCommand(['SET', REDIS_KEY, JSON.stringify(data)]);
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    data = {
      ...JSON.parse(JSON.stringify(DEFAULT_DATA)),
      ...parsed,
      settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) }
    };
  } catch (e) {
    console.error('Failed to parse data from Upstash, starting fresh:', e.message);
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

function loadFromFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    data = {
      ...JSON.parse(JSON.stringify(DEFAULT_DATA)),
      ...parsed,
      settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) }
    };
  } catch (e) {
    console.error('Failed to read data.json, starting fresh:', e.message);
    data = JSON.parse(JSON.stringify(DEFAULT_DATA));
  }
}

// One-time rebrand migration. The settings above are only used for brand-new
// stores — once a store has run once, its settings are saved in the database
// and take priority over these defaults forever after. This migration checks
// for the specific old values and swaps them for the new ones exactly once;
// it does nothing (and costs nothing) once the values no longer match, so
// it's safe to leave in permanently.
const REBRAND_MIGRATIONS = {
  whatsappNumber: { from: '0760565047', to: '260779173957' },
  supportPhone: { from: '0760565047', to: '+260779173957' },
};
async function applyRebrandMigration() {
  let changed = false;
  for (const [key, { from, to }] of Object.entries(REBRAND_MIGRATIONS)) {
    if (data.settings[key] === from) {
      data.settings[key] = to;
      changed = true;
    }
  }
  if (changed) {
    console.log('Applied one-time rebrand migration to stored settings.');
    await persist();
  }
}

// One-time migration: the store used to support exactly one admin account
// (data.admin). Multi-admin support stores accounts in data.admins instead;
// fold any pre-existing single admin into that array so nobody gets locked
// out of a site that already had an admin set up before this change.
async function migrateAdminList() {
  if (!Array.isArray(data.admins)) data.admins = [];
  if (data.admin && data.admins.length === 0) {
    data.admins.push({ username: data.admin.username, passwordHash: data.admin.passwordHash });
    console.log('Migrated legacy single admin account into the admins list.');
    await persist();
  }
}

async function init() {
  if (useUpstash) {
    console.log(`Datastore: Upstash Redis (key "${REDIS_KEY}")`);
    await loadFromUpstash();
  } else {
    console.log(`Datastore: local file ${DATA_FILE} (set UPSTASH_REDIS_REST_URL/TOKEN for storage that survives restarts on free hosting)`);
    loadFromFile();
  }
  await applyRebrandMigration();
  await migrateAdminList();
}

function persist() {
  writeQueue = writeQueue.then(async () => {
    if (useUpstash) {
      await upstashCommand(['SET', REDIS_KEY, JSON.stringify(data)]);
    } else {
      const tmp = DATA_FILE + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2));
      await fs.promises.rename(tmp, DATA_FILE);
    }
  });
  return writeQueue;
}

module.exports = {
  init,
  getData() { return data; },
  async save() { await persist(); },
  dataFile: DATA_FILE,
};
