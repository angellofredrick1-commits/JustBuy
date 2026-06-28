/**
 * netlify/functions/order.js
 * POST /.netlify/functions/order
 *
 * Accepts: { name, phone, productTitle, productUrl, totalTZS, priceUSD }
 *
 * Fires two WhatsApp messages via Twilio:
 *   1. Ops alert → your JustBuy number
 *   2. Customer confirmation → their number
 */

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON' });
  }

  const { name, phone, productTitle, productUrl, totalTZS, priceUSD } = body;

  if (!name || !phone) {
    return respond(400, { error: 'name and phone are required' });
  }

  /* Normalise phone: 07xx → +25507xx */
  const cleanPhone = normalisePhone(phone);

  const order = {
    name:         String(name).slice(0, 80),
    phone:        cleanPhone,
    productTitle: String(productTitle || 'Unknown product').slice(0, 200),
    productUrl:   String(productUrl   || '').slice(0, 500),
    totalTZS:     Number(totalTZS)  || 0,
    priceUSD:     Number(priceUSD)  || 0,
  };

  /* Fire both notifications — don't block on failure */
  const [opsOk, custOk] = await Promise.allSettled([
    sendWhatsApp(opsMessage(order),      process.env.WHATSAPP_OPS_NUMBER),
    sendWhatsApp(customerMessage(order), order.phone),
  ]);

  console.log('[order] ops:', opsOk.status, '| customer:', custOk.status);

  /* Always return success to the user */
  return respond(200, {
    success: true,
    message: 'Order received! A JustBuy agent will contact you on WhatsApp shortly.',
  });
};

/* ════════════════════════════════════════
   TWILIO WHATSAPP
════════════════════════════════════════ */
async function sendWhatsApp(messageBody, toNumber) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_WHATSAPP_FROM; // whatsapp:+14155238886

  if (!sid || !token || !from || !toNumber) {
    console.warn('[order] Twilio not configured — skipping WhatsApp send');
    return false;
  }

  /* Ensure number has whatsapp: prefix */
  const to = toNumber.startsWith('whatsapp:')
    ? toNumber
    : `whatsapp:${toNumber}`;

  const params = new URLSearchParams({
    From: from,
    To:   to,
    Body: messageBody,
  });

  const credentials = Buffer.from(`${sid}:${token}`).toString('base64');

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[order] Twilio error:', err.message || res.status);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[order] WhatsApp send failed:', err.message);
    return false;
  }
}

/* ════════════════════════════════════════
   MESSAGE TEMPLATES
════════════════════════════════════════ */
function opsMessage(o) {
  const now = new Date().toLocaleString('en-TZ', { timeZone: 'Africa/Dar_es_Salaam' });
  return [
    `🛒 *NEW JUSTBUY ORDER*`,
    `📅 ${now}`,
    ``,
    `👤 *Customer:* ${o.name}`,
    `📱 *WhatsApp:* ${o.phone}`,
    ``,
    `📦 *Product:* ${o.productTitle}`,
    `🔗 *Link:* ${o.productUrl || 'N/A'}`,
    ``,
    `💵 *Item price:* USD ${o.priceUSD.toFixed(2)}`,
    `💰 *Total estimate:* TZS ${o.totalTZS.toLocaleString()}`,
    ``,
    `👉 Contact customer to confirm payment.`,
  ].join('\n');
}

function customerMessage(o) {
  return [
    `✅ *JustBuy — Order Received!*`,
    ``,
    `Hi ${o.name}! We've got your order request.`,
    ``,
    `📦 *Product:* ${o.productTitle.slice(0, 80)}`,
    `💰 *Total estimate:* TZS ${o.totalTZS.toLocaleString()}`,
    ``,
    `A JustBuy agent will confirm your order and`,
    `payment details within 30 minutes. 🇹🇿`,
    ``,
    `Questions? Just reply to this message.`,
  ].join('\n');
}

/* ════════════════════════════════════════
   UTILS
════════════════════════════════════════ */
function normalisePhone(phone) {
  let p = phone.replace(/\s+/g, '').replace(/[-()]/g, '');
  /* 0712345678 → +255712345678 */
  if (p.startsWith('0') && p.length === 10) p = '+255' + p.slice(1);
  /* 255712345678 → +255712345678 */
  if (p.startsWith('255') && !p.startsWith('+')) p = '+' + p;
  /* already has + */
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

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
