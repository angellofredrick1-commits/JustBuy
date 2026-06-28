async function fetchWithScraperAPI(url) {
  const key = process.env.SCRAPERAPI_KEY;
  if (!key) throw new Error('SCRAPERAPI_KEY not set');

  const u = url.toLowerCase();

  // Use ScraperAPI's structured Amazon endpoint for Amazon URLs
  if (u.includes('amazon')) {
    const structured =
      `https://api.scraperapi.com/structured/amazon/product` +
      `?api_key=${key}` +
      `&url=${encodeURIComponent(url)}`;

    const res = await fetchWithTimeout(structured, {}, 20000);
    if (res.ok) {
      const data = await res.json();
      // Return a fake HTML string with the data embedded as JSON-LD
      // so the existing parser picks it up
      if (data.name && data.pricing) {
        return `<html><head>
          <script type="application/ld+json">
          {"@type":"Product","name":${JSON.stringify(data.name)},
          "image":${JSON.stringify(data.images?.[0] || '')},
          "offers":{"price":${JSON.stringify(data.pricing.replace(/[^0-9.]/g,''))},
          "priceCurrency":"${url.includes('.co.uk') ? 'GBP' : url.includes('.de') ? 'EUR' : 'USD'}"}
          }
          <\/script></head><body></body></html>`;
      }
    }
  }

  // Standard endpoint for all other stores
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
