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
  admin: null,
  settings: {
    storeName: 'Godwyn Stores',
    tagline: 'Quality goods, delivered across Zambia.',
    currency: 'ZMW',
    whatsappNumber: '0760565047',
    supportPhone: '0760565047',
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

async function init() {
  if (useUpstash) {
    console.log(`Datastore: Upstash Redis (key "${REDIS_KEY}")`);
    await loadFromUpstash();
  } else {
    console.log(`Datastore: local file ${DATA_FILE} (set UPSTASH_REDIS_REST_URL/TOKEN for storage that survives restarts on free hosting)`);
    loadFromFile();
  }
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
