const https = require('https');
const http = require('http');

const PORT = process.env.PORT || 3001;

// Hamburg GBFS feeds - confirmed working
const FEEDS = [
  {
    provider: 'Lime',
    url: 'https://data.lime.bike/api/partners/v2/gbfs/hamburg/free_bike_status',
  },
  {
    provider: 'Voi',
    url: 'https://api.voiapp.io/v1/gbfs/1/hamburg/free_bike_status',
    fallback: 'https://api.mobidata-bw.de/sharing/gbfs/v3/voi_de/free_bike_status.json',
  },
  {
    provider: 'Tier',
    url: 'https://data.tier.app/gbfs/v2/hamburg/free_bike_status.json',
  },
  {
    provider: 'Bolt',
    url: 'https://mds.bolt.eu/gbfs/2/hamburg/free_bike_status',
  },
];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: 7000,
      headers: {
        'User-Agent': 'RollerHub/1.0 (contact@rollerhub.app)',
        'Accept': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(data) }); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

async function fetchFeed(feed) {
  const urls = [feed.url, feed.fallback].filter(Boolean);
  for (const url of urls) {
    try {
      const { status, json } = await fetchJSON(url);
      if (status !== 200) continue;
      const bikes = json?.data?.bikes || [];
      if (bikes.length === 0) continue;
      return bikes
        .filter(b => !b.is_reserved && !b.is_disabled)
        .map(b => ({
          id: `${feed.provider}-${b.bike_id}`,
          provider: feed.provider,
          lat: b.lat,
          lng: b.lon,
          battery: b.current_range_meters != null
            ? Math.min(100, Math.round(b.current_range_meters / 120))
            : null,
        }))
        .filter(s => s.lat && s.lng);
    } catch (e) {
      console.log(`${feed.provider} (${url}): ${e.message}`);
    }
  }
  return [];
}

// Cache
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 30 * 1000; // 30 seconds

async function getScooters() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  const results = await Promise.allSettled(FEEDS.map(fetchFeed));
  const scooters = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  const providerStatus = {};
  FEEDS.forEach((feed, i) => {
    const r = results[i];
    const count = r.status === 'fulfilled' ? r.value.length : 0;
    providerStatus[feed.provider] = { ok: count > 0, count };
  });

  cache = { scooters, providerStatus, total: scooters.length, timestamp: now };
  cacheTime = now;
  console.log(`Fetched: ${scooters.length} scooters | ${JSON.stringify(providerStatus)}`);
  return cache;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // CORS - allow all origins
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url?.split('?')[0];

  if (url === '/api/scooters') {
    try {
      const data = await getScooters();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (url === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  if (url === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ name: 'RollerHub API', version: '1.0.0', endpoints: ['/api/scooters', '/api/health'] }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`RollerHub API running on port ${PORT}`);
  // Pre-warm cache
  getScooters().catch(console.error);
});
