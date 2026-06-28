/**
 * netlify/functions/scrape.js
 * POST /.netlify/functions/scrape
 *
 * Accepts: { url: string }
 *
 * Returns:
 *   { scraped: true,  title, image, source, priceUSD, rate, breakdown }
 *   { scraped: false, source, title? }   ← frontend shows manual form
 */

const cheerio = require('cheerio');

/* ── Cost constants ── */
const SHIPPING_USD = 10;
const SERVICE_PCT  = 0.05;
const DUTY_PCT     = 0.15;
const FALLBACK_RATE = 2600;

/* ── In-memory exchange rate cache ── */
let cachedRate    = null;
let cacheExpiry   = 0;

/* ════════════════════════════════════════
   HANDLER
════════════════════════════════════════ */
exports.handler = async function (event) {
  /* Only accept POST */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  /* Parse body */
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const { url } = body;
  if (!url || typeof url !== 'string') {
    return respond(400, { error: 'url is required' });
  }

  /* Validate URL */
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error();
  } catch {
    return respond(400, { error: 'Invalid URL' });
  }

  const source = parsedUrl.hostname.replace(/^www\./, '');

  /* ── Fetch page via ScraperAPI ── */
  let html;
  try {
    html = await fetchWithScraperAPI(url);
  } catch (err) {
    console.error('[scrape] ScraperAPI failed:', err.message);
    return respond(200, { scraped: false, source });
  }

  /* ── Parse product data ── */
  const product = parseProduct(html, url, source);

  if (!product.price || product.price <= 0) {
    return respond(200, {
      scraped: false,
      source,
      title: product.title || undefined,
      image: product.image || undefined,
    });
  }

  /* ── Currency → USD ── */
  const priceUSD = await toUSD(product.price, product.currency);

  /* ── Exchange rate ── */
  const rate = await getRate();

  /* ── Cost breakdown ── */
  const breakdown = calcBreakdown(priceUSD, rate);

  return respond(200, {
    scraped:  true,
    title:    product.title,
    image:    product.image,
    source,
    priceUSD: round2(priceUSD),
    rate,
    breakdown,
  });
};

/* ════════════════════════════════════════
   SCRAPERAPI FETCH
════════════════════════════════════════ */
async function fetchWithScraperAPI(url) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) throw new Error('SCRAPERAPI_KEY not set');

  const endpoint =
    `https://api.scraperapi.com` +
    `?api_key=${key}` +
    `&url=${encodeURIComponent(url)}` +
    `&render=true` +
    `&premium=true` +
    `&country_code=us`;

  const res = await fetchWithTimeout(endpoint, {}, 20000);
  if (!res.ok) throw new Error(`ScraperAPI ${res.status}`);
  return res.text();
}

/* ════════════════════════════════════════
   PRODUCT PARSER
════════════════════════════════════════ */
function parseProduct(html, url, source) {
  const $ = cheerio.load(html);

  /* 1 — JSON-LD structured data (most reliable) */
  const ld = extractJsonLd($);

  /* 2 — Open Graph meta tags */
  const og = extractOpenGraph($);

  /* 3 — Store-specific CSS selectors */
  const sp = extractByStore($, url);

  const title = (
    ld.title || og.title || sp.title ||
    $('h1').first().text().trim() || ''
  ).slice(0, 200);

  const price    = ld.price    ?? og.price    ?? sp.price    ?? null;
  const currency = (ld.currency || og.currency || sp.currency || 'USD').toUpperCase();
  const image    = ld.image    || og.image    || sp.image    || null;

  return { title, price, currency, image };
}

function extractJsonLd($) {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const el of scripts) {
    try {
      const data  = JSON.parse($(el).html() || '{}');
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'Product' || item.offers) {
          const offer = Array.isArray(item.offers) ? item.offers[0] : item.offers;
          if (offer?.price) {
            return {
              title:    item.name || '',
              price:    parseFloat(String(offer.price)),
              currency: offer.priceCurrency || 'USD',
              image:    Array.isArray(item.image) ? item.image[0] : (item.image || null),
            };
          }
        }
      }
    } catch { /* skip malformed */ }
  }
  return {};
}

function extractOpenGraph($) {
  const get = (prop) =>
    $(`meta[property="${prop}"]`).attr('content') ||
    $(`meta[name="${prop}"]`).attr('content') || '';

  const priceStr = get('product:price:amount') || get('og:price:amount');
  const price    = priceStr ? parseFloat(priceStr) : null;

  return {
    title:    get('og:title') || get('twitter:title') || '',
    image:    get('og:image') || get('twitter:image') || null,
    price:    price && !isNaN(price) ? price : null,
    currency: get('product:price:currency') || get('og:price:currency') || 'USD',
  };
}

function extractByStore($, url) {
  const u = url.toLowerCase();
  if (u.includes('amazon'))     return extractAmazon($);
  if (u.includes('ebay'))       return extractEbay($);
  if (u.includes('aliexpress')) return extractAli($);
  if (u.includes('asos'))       return extractAsos($);
  if (u.includes('zara'))       return extractZara($);
  return {};
}

function extractAmazon($) {
  const offscreen = $('.a-price .a-offscreen').first().text();
  const whole     = $('.a-price-whole').first().text().replace(/[^0-9]/g, '');
  const frac      = $('.a-price-fraction').first().text().replace(/[^0-9]/g, '') || '00';
  const deal      = $('#priceblock_dealprice').text();
  const our       = $('#priceblock_ourprice').text();
  const raw       = offscreen || deal || our || (whole ? `${whole}.${frac}` : '');
  const price     = raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : null;
  return {
    title: ($('#productTitle').text() || $('h1').first().text()).trim(),
    price: price && !isNaN(price) ? price : null,
    currency: 'USD',
    image: $('#landingImage').attr('src') || $('#imgBlkFront').attr('src') || null,
  };
}

function extractEbay($) {
  const raw   = $('.x-price-primary .ux-textspans').first().text() ||
                $('[itemprop="price"]').attr('content') || '';
  const price = raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : null;
  return {
    title:    $('h1.x-item-title__mainTitle span').text().trim() || $('h1').first().text().trim(),
    price:    price && !isNaN(price) ? price : null,
    currency: 'USD',
    image:    $('[itemprop="image"]').attr('src') || null,
  };
}

function extractAli($) {
  /* AliExpress stores price in window.runParams — scan scripts */
  const scripts = $('script').toArray();
  for (const el of scripts) {
    const c = $(el).html() || '';
    const m = c.match(/"activityAmount"\s*:\s*\{[^}]*"value"\s*:\s*"([\d.]+)"/);
    if (m) return { price: parseFloat(m[1]), currency: 'USD', title: $('h1').first().text().trim(), image: null };
  }
  const raw = $('[class*="price"]').first().text();
  return { price: raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : null, currency: 'USD', title: $('h1').first().text().trim(), image: null };
}

function extractAsos($) {
  const raw      = $('[data-id="current-price"]').text() || $('[class*="price__current"]').text();
  const price    = raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : null;
  const currency = raw.includes('£') ? 'GBP' : 'USD';
  return { title: $('h1').first().text().trim(), price: price && !isNaN(price) ? price : null, currency, image: $('[class*="ProductGallery"] img').first().attr('src') || null };
}

function extractZara($) {
  const raw      = $('[class*="price__amount"]').first().text();
  const price    = raw ? parseFloat(raw.replace(/[^0-9.]/g, '')) : null;
  const currency = raw.includes('€') ? 'EUR' : raw.includes('£') ? 'GBP' : 'USD';
  return { title: $('h1').first().text().trim(), price: price && !isNaN(price) ? price : null, currency, image: $('meta[property="og:image"]').attr('content') || null };
}

/* ════════════════════════════════════════
   EXCHANGE RATE
════════════════════════════════════════ */
async function getRate() {
  if (cachedRate && Date.now() < cacheExpiry) return cachedRate;

  const key = process.env.EXCHANGERATE_KEY;
  if (!key) return FALLBACK_RATE;

  try {
    const res  = await fetchWithTimeout(
      `https://v6.exchangerate-api.com/v6/${key}/pair/USD/TZS`, {}, 5000
    );
    const data = await res.json();
    if (data.conversion_rate) {
      cachedRate  = data.conversion_rate;
      cacheExpiry = Date.now() + 60 * 60 * 1000; // 1 hour
      return cachedRate;
    }
  } catch (err) {
    console.warn('[scrape] Exchange rate fetch failed:', err.message);
  }
  return cachedRate || FALLBACK_RATE;
}

async function toUSD(amount, currency) {
  if (currency === 'USD') return amount;

  const key = process.env.EXCHANGERATE_KEY;
  if (!key) {
    /* Hardcoded fallbacks */
    const rates = { EUR: 1.08, GBP: 1.27, CNY: 0.14, AED: 0.27 };
    return amount * (rates[currency] || 1);
  }
  try {
    const res  = await fetchWithTimeout(
      `https://v6.exchangerate-api.com/v6/${key}/pair/${currency}/USD`, {}, 5000
    );
    const data = await res.json();
    return amount * (data.conversion_rate || 1);
  } catch {
    return amount;
  }
}

/* ════════════════════════════════════════
   COST FORMULA
════════════════════════════════════════ */
function calcBreakdown(priceUSD, rate) {
  const itemTZS     = priceUSD * rate;
  const shippingTZS = SHIPPING_USD * rate;
  const serviceTZS  = itemTZS * SERVICE_PCT;
  const dutyTZS     = itemTZS * DUTY_PCT;
  const totalTZS    = itemTZS + shippingTZS + serviceTZS + dutyTZS;
  return {
    itemTZS:     Math.round(itemTZS),
    shippingTZS: Math.round(shippingTZS),
    serviceTZS:  Math.round(serviceTZS),
    dutyTZS:     Math.round(dutyTZS),
    totalTZS:    Math.round(totalTZS),
    totalUSD:    round2(totalTZS / rate),
  };
}

/* ════════════════════════════════════════
   UTILS
════════════════════════════════════════ */
function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function round2(n) { return Math.round(n * 100) / 100; }

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
