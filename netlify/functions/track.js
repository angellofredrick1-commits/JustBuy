// JustBuy shipment tracking — calls the Aramex Shipment Tracking API (SOAP).
//
// Credentials are read from Netlify environment variables
// (Site configuration → Environment variables). Never put them in this file.
//
//   ARAMEX_USERNAME         API username (email)
//   ARAMEX_PASSWORD         API password
//   ARAMEX_ACCOUNT_NUMBER   Aramex account number
//   ARAMEX_ACCOUNT_PIN      Account PIN
//   ARAMEX_ACCOUNT_ENTITY   3-letter entity code, e.g. DAR
//   ARAMEX_COUNTRY_CODE     optional, defaults to TZ
//   ARAMEX_TRACKING_URL     optional, overrides the default endpoint below
//
// Until the required variables are set, the function runs in DEMO mode and
// returns sample tracking events so the page can be tested end to end.

const DEFAULT_URL = "https://ws.aramex.net/ShippingAPI.V2/Tracking/Service_1_0.svc";
const SOAP_ACTION = "http://ws.aramex.net/ShippingAPI/v1/Service_1_0/TrackShipments";
const MAX_WAYBILLS = 10;
const WAYBILL_RE = /^[A-Za-z0-9-]{5,30}$/;

const HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const reply = (status, body) => ({ statusCode: status, headers: HEADERS, body: JSON.stringify(body) });

const xmlEscape = (s) =>
  String(s ?? "").replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

const xmlDecode = (s) =>
  String(s ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&")
    .trim();

// Matches <Tag>…</Tag> with or without a namespace prefix (a:Tag, b:Tag …).
const tagRe = (tag, flags = "") =>
  new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*[^/>])?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, flags);

const field = (xml, tag) => {
  const m = xml.match(tagRe(tag));
  return m ? xmlDecode(m[1]) : "";
};

const all = (xml, tag) => [...xml.matchAll(tagRe(tag, "g"))].map((m) => m[1]);

function buildEnvelope(c, waybills, lastOnly) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:v1="http://ws.aramex.net/ShippingAPI/v1/"
  xmlns:arr="http://schemas.microsoft.com/2003/10/Serialization/Arrays">
  <soapenv:Body>
    <v1:ShipmentTrackingRequest>
      <v1:ClientInfo>
        <v1:UserName>${xmlEscape(c.username)}</v1:UserName>
        <v1:Password>${xmlEscape(c.password)}</v1:Password>
        <v1:Version>v1.0</v1:Version>
        <v1:AccountNumber>${xmlEscape(c.accountNumber)}</v1:AccountNumber>
        <v1:AccountPin>${xmlEscape(c.accountPin)}</v1:AccountPin>
        <v1:AccountEntity>${xmlEscape(c.accountEntity)}</v1:AccountEntity>
        <v1:AccountCountryCode>${xmlEscape(c.countryCode)}</v1:AccountCountryCode>
      </v1:ClientInfo>
      <v1:Transaction>
        <v1:Reference1>justbuy-tracking</v1:Reference1>
        <v1:Reference2></v1:Reference2>
        <v1:Reference3></v1:Reference3>
        <v1:Reference4></v1:Reference4>
        <v1:Reference5></v1:Reference5>
      </v1:Transaction>
      <v1:Shipments>
${waybills.map((w) => `        <arr:string>${xmlEscape(w)}</arr:string>`).join("\n")}
      </v1:Shipments>
      <v1:GetLastTrackingUpdateOnly>${lastOnly ? "true" : "false"}</v1:GetLastTrackingUpdateOnly>
    </v1:ShipmentTrackingRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function parseResponse(xml, requested) {
  const fault = xml.match(tagRe("faultstring"));
  if (fault) return { ok: false, error: "Aramex service error: " + xmlDecode(fault[1]) };

  const hasErrors = /^true$/i.test(field(xml, "HasErrors"));
  const notifications = all(xml, "Notification")
    .map((n) => ({ code: field(n, "Code"), message: field(n, "Message") }))
    .filter((n) => n.code || n.message);

  const byWaybill = {};
  for (const kv of all(xml, "KeyValueOfstringArrayOfTrackingResult\\w*")) {
    const key = field(kv, "Key");
    const events = all(kv, "TrackingResult").map((t) => ({
      code: field(t, "UpdateCode"),
      description: field(t, "UpdateDescription"),
      dateTime: field(t, "UpdateDateTime"),
      location: field(t, "UpdateLocation"),
      comments: field(t, "Comments"),
      problemCode: field(t, "ProblemCode"),
    }));
    events.sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime)); // newest first
    if (key) byWaybill[key] = events;
  }

  const shipments = requested.map((w) => ({
    waybill: w,
    found: Array.isArray(byWaybill[w]) && byWaybill[w].length > 0,
    events: byWaybill[w] || [],
  }));

  return { ok: !hasErrors, hasErrors, notifications, shipments };
}

function demoResult(waybills) {
  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * 3600e3).toISOString();
  return {
    ok: true,
    demo: true,
    notifications: [],
    shipments: waybills.map((w) => ({
      waybill: w,
      found: true,
      events: [
        { code: "SH203", description: "Arrived at destination facility", dateTime: at(6), location: "Dar es Salaam, TZ", comments: "", problemCode: "" },
        { code: "SH014", description: "Departed origin facility", dateTime: at(70), location: "Dubai, AE", comments: "", problemCode: "" },
        { code: "SH047", description: "Received at origin facility", dateTime: at(96), location: "Dubai, AE", comments: "", problemCode: "" },
        { code: "SH001", description: "Shipment created", dateTime: at(120), location: "New York, US", comments: "", problemCode: "" },
      ],
    })),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: HEADERS, body: "" };

  let input = {};
  if (event.httpMethod === "POST") {
    try { input = JSON.parse(event.body || "{}"); } catch { return reply(400, { ok: false, error: "Invalid JSON body." }); }
  } else if (event.httpMethod === "GET") {
    input = { waybills: (event.queryStringParameters?.waybill || "").split(",") };
  } else {
    return reply(405, { ok: false, error: "Use GET or POST." });
  }

  const raw = Array.isArray(input.waybills) ? input.waybills : String(input.waybills || "").split(/[\s,;]+/);
  const waybills = [...new Set(raw.map((w) => String(w).trim()).filter(Boolean))];

  if (!waybills.length) return reply(400, { ok: false, error: "Enter at least one waybill number." });
  if (waybills.length > MAX_WAYBILLS) return reply(400, { ok: false, error: `Track up to ${MAX_WAYBILLS} shipments at a time.` });
  const bad = waybills.find((w) => !WAYBILL_RE.test(w));
  if (bad) return reply(400, { ok: false, error: `"${bad}" doesn't look like a waybill number.` });

  const env = process.env;
  const creds = {
    username: env.ARAMEX_USERNAME,
    password: env.ARAMEX_PASSWORD,
    accountNumber: env.ARAMEX_ACCOUNT_NUMBER,
    accountPin: env.ARAMEX_ACCOUNT_PIN,
    accountEntity: env.ARAMEX_ACCOUNT_ENTITY,
    countryCode: env.ARAMEX_COUNTRY_CODE || "TZ",
  };
  const missing = ["username", "password", "accountNumber", "accountPin", "accountEntity"].filter((k) => !creds[k]);
  if (missing.length) return reply(200, demoResult(waybills));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(env.ARAMEX_TRACKING_URL || DEFAULT_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: SOAP_ACTION },
      body: buildEnvelope(creds, waybills, !!input.lastOnly),
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = parseResponse(text, waybills);
    if (!res.ok && !parsed.error && !parsed.hasErrors) {
      return reply(502, { ok: false, error: `Aramex returned HTTP ${res.status}.` });
    }
    return reply(parsed.error ? 502 : 200, parsed);
  } catch (err) {
    const msg = err.name === "AbortError" ? "Aramex took too long to respond. Try again." : "Couldn't reach Aramex. Try again.";
    console.error("track error:", err);
    return reply(502, { ok: false, error: msg });
  } finally {
    clearTimeout(timer);
  }
};

// Exported for local tests.
exports._internal = { buildEnvelope, parseResponse };
