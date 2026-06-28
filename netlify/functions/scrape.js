/**
 * netlify/functions/scrape.js
 * Simplified version with detailed logging for diagnosis
 */

exports.handler = async function (event) {

  /* ── CORS preflight ── */
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  /* ── Parse body ── */
  let url;
  try {
    const body = JSON.parse(event.body || '{}');
    url = body.url;
    console.log('[scrape] Received URL:', url);
  } catch (e) {
    console.error('[scrape] JSON parse error:', e.message);
    return json(400, { error: 'Invalid JSON' });
  }

  if (!url) {
    return json(400, { error: 'url is required' });
  }

  /* ── Check env vars ── */
  const apiKey = process.env.SCRAPERAPI_KEY;
  console.log('[scrape] SCRAPERAPI_KEY set:', !!apiKey);
  console.log('[scrape] EXCHANGERATE_KEY set:', !!process.env.EXCHANGERATE_KEY);

  if (!apiKey) {
    console.error('[scrape] No SCRAPERAPI_KEY — returning fallback');
    return json(200, {
      scraped: false,
      source: safeHost(url),
      error: 'API key not configured',
    });
  }

  /* ── Fetch via ScraperAPI ── */
  console.log('[scrape] Calling ScraperAPI...');

  let html;
  try {
    const scraperUrl =
      `https://api.scraperapi.com` +
      `?api_key=${apiKey}` +
      `&url=${encodeURIComponent(url)}` +
      `&render=true` +
      `&premium=true`;

    console.log('[scrape] ScraperAPI endpoint built (key hidden)');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);

    const res = await fetch(scraperUrl, { signal: controller.signal });
    clearTimeout(timer);

    console.log('[scrape] ScraperAPI status:', res.status);

    if (!res.ok) {
      const errText = await res.text();
      console.error('[scrape] ScraperAPI error body:', errText.slice(0, 200));
      return json(200, { scraped: false, source: safeHost(url), error: `ScraperAPI ${res.status}` });
    }

    html = await res.text();
    console.log('[scrape] HTML received, length:', html.length);

  } catch (err) {
    console.error('[scrape] Fetch failed:', err.message);
    return json(200, { scraped: false, source: safeHost(url), error: err.message });
  }

  /* ── Parse price from HTML ── */
  let price = null;
  let title = '';
  let image = null;
  const currency = detectCurrency(url);

  /* 1. JSON-LD */
  const ldMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  if (ldMatch) {
    for (const block of ldMatch) {
      try {
        const inner = block.replace(/<[^>]+>/g, '').trim();
        const data = JSON.parse(inner);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offer && offer.price) {
            price = parseFloat(String(offer.price).replace(/[^0-9.]/g, ''));
            title = item.name || '';
            image = Array.isArray(item.image) ? item.image[0] : (item.image || null);
            console.log('[scrape] JSON-LD price found:', price, currency);
            break;
          }
        }
      } catch (e) { /* skip */ }
      if (price) break;
    }
  }

  /* 2. Open Graph */
  if (!price) {
    const ogPrice = html.match(/property=["']product:price:amount["'][^>]*content=["']([^"']+)["']/i)
                 || html.match(/content=["']([^"']+)["'][^>]*property=["']product:price:amount["']/i);
    if (ogPrice) {
      price = parseFloat(ogPrice[1]);
      console.log('[scrape] OG price found:', price);
    }

    const ogTitle = html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
                 || html.match(/content=["']([^"']*?)["'][^>]*property=["']og:title["']/i);
    if (ogTitle && !title) title = ogTitle[1];

    const ogImage = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                  || html.match(/content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
    if (ogImage && !image) image = ogImage[1];
  }

  /* 3. Amazon-specific */
  if (!price && url.toLowerCase().includes('amazon')) {
    const amzMatch = html.match(/class="a-offscreen"[^>]*>([^<]+)</)
                  || html.match(/id="priceblock_ourprice"[^>]*>([^<]+)</)
                  || html.match(/id="priceblock_dealprice"[^>]*>([^<]+)</);
    if (amzMatch) {
      price = parseFloat(amzMatch[1].replace(/[^0-9.]/g, ''));
      console.log('[scrape] Amazon CSS price:', price);
    }
    const titleMatch = html.match(/id="productTitle"[^>]*>\s*([^<]+)/);
    if (titleMatch && !title) title = titleMatch[1].trim();
  }

  /* 4. Generic price pattern */
  if (!price) {
    const genericMatch = html.match(/["']price["'][^>]*>\s*[£$€]?\s*([\d,]+\.?\d{0,2})/i);
    if (genericMatch) {
      price = parseFloat(genericMatch[1].replace(/,/g, ''));
      console.log('[scrape] Generic price found:', price);
    }
  }

  /* H1 fallback for title */
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([^<]{3,100})<\/h1>/i);
    if (h1) title = h1[1].trim();
  }

  console.log('[scrape] Final — price:', price, '| title:', title.slice(0, 60), '| currency:', currency);

  if (!price || isNaN(price) || price <= 0) {
    console.log('[scrape] No price found — returning fallback');
    return json(200, {
      scraped: false,
      source: safeHost(url),
      title: title || undefined,
      image: image || undefined,
    });
  }

  /* ── Currency → USD ── */
  const priceUSD = await toUSD(price, currency);
  console.log('[scrape] priceUSD:', priceUSD);

  /* ── Exchange rate ── */
  const rate = await getRate();
  console.log('[scrape] rate:', rate);

  /* ── Breakdown ── */
  const itemTZS     = Math.round(priceUSD * rate);
  const shippingTZS = Math.round(10 * rate);
  const serviceTZS  = Math.round(itemTZS * 0.05);
  const dutyTZS     = Math.round(itemTZS * 0.15);
  const totalTZS    = itemTZS + shippingTZS + serviceTZS + dutyTZS;

  console.log('[scrape] SUCCESS — totalTZS:', totalTZS);

  return json(200, {
    scraped:  true,
    title:    (title || 'Product').slice(0, 200),
    image:    image || null,
    source:   safeHost(url),
    priceUSD: Math.round(priceUSD * 100) / 100,
    rate,
    breakdown: {
      itemTZS,
      shippingTZS,
      serviceTZS,
      dutyTZS,
      totalTZS,
      totalUSD: Math.round(totalTZS / rate * 100) / 100,
    },
  });
};

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */

function detectCurrency(url) {
  const u = url.toLowerCase();
  if (u.includes('amazon.co.uk') || u.includes('asos.com')) return 'GBP';
  if (u.includes('amazon.de') || u.includes('zara.com')) return 'EUR';
  return 'USD';
}

async function toUSD(amount, currency) {
  if (currency === 'USD') return amount;
  const key = process.env.EXCHANGERATE_KEY;
  if (!key) {
    const rates = { GBP: 1.27, EUR: 1.08, CNY: 0.14 };
    return amount * (rates[currency] || 1);
  }
  try {
    const res  = await fetch(`https://v6.exchangerate-api.com/v6/${key}/pair/${currency}/USD`);
    const data = await res.json();
    return amount * (data.conversion_rate || 1);
  } catch {
    const rates = { GBP: 1.27, EUR: 1.08 };
    return amount * (rates[currency] || 1);
  }
}

let _cachedRate = null;
let _cacheExp   = 0;

async function getRate() {
  if (_cachedRate && Date.now() < _cacheExp) return _cachedRate;
  const key = process.env.EXCHANGERATE_KEY;
  if (!key) return 2600;
  try {
    const res  = await fetch(`https://v6.exchangerate-api.com/v6/${key}/pair/USD/TZS`);
    const data = await res.json();
    if (data.conversion_rate) {
      _cachedRate = data.conversion_rate;
      _cacheExp   = Date.now() + 3600000;
      return _cachedRate;
    }
  } catch { /* fallback */ }
  return 2600;
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return 'unknown'; }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
