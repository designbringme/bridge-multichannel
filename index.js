const express = require("express");
const querystring = require("querystring");
const crypto = require("crypto");
const { Redis } = require("@upstash/redis");

const app = express();
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_AGE_SECONDS = 24 * 60 * 60;
const MAX_ITEMS_PER_POLL = 100;
const PLATFORM_NAMES = new Set(["saweria", "sociabuzz", "bagibagi", "tako"]);

function loadChannels() {
  try {
    const parsed = JSON.parse(process.env.DONATION_CHANNELS_JSON || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch (error) {
    console.error("[config] DONATION_CHANNELS_JSON is invalid:", error.message);
    return {};
  }
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function getAccount(accountId) {
  const account = loadChannels()[accountId];
  if (!account || typeof account !== "object") return null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(account.channel || ""))) return null;
  return account;
}

function authenticate(req, account, kind) {
  const supplied = kind === "webhook" ? req.query.key : req.query.pollKey;
  const expected = kind === "webhook" ? account.webhookSecret : account.pollSecret;
  return typeof expected === "string" && expected.length >= 16 && constantTimeEqual(supplied, expected);
}

// Vercel may provide req.body already; otherwise parse JSON or form data.
app.use((req, res, next) => {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) return next();
  if (req.method === "GET" || req.method === "HEAD") { req.body = {}; return next(); }
  let raw = "";
  req.on("data", chunk => { raw += chunk; });
  req.on("end", () => {
    if (!raw) { req.body = {}; return next(); }
    try { req.body = JSON.parse(raw); }
    catch (_) { req.body = querystring.parse(raw); }
    next();
  });
  req.on("error", () => { req.body = {}; next(); });
});

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

function normalizeDonation(platform, body) {
  const d = body && body.data && typeof body.data === "object" ? body.data : (body || {});
  const amount = Number(
    platform === "saweria"
      ? (d.amount_raw || d.amount || d.donation_amount || (d.etc && d.etc.amount_to_display) || 0)
      : (d.amount || d.value || d.nominal || d.total || 0)
  );
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const fields = {
    saweria: { id: d.id || d._id, name: d.donator_name || d.name, message: d.donator_msg || d.message },
    sociabuzz: { id: d.trx_id || d.id, name: d.from || d.username || d.name, message: d.message || d.note },
    bagibagi: { id: d.id || d.transaction_id, name: d.sender || d.name || d.username, message: d.message || d.note },
    tako: { id: d.id || d.order_id, name: d.username || d.display_name || d.name, message: d.message || d.comment },
  }[platform];
  return {
    providerId: fields && fields.id ? String(fields.id) : null,
    source: platform,
    donorName: String((fields && fields.name) || "Anonymous").slice(0, 120),
    amount: Math.round(amount),
    currency: "IDR",
    message: String((fields && fields.message) || "").slice(0, 1000),
    receivedAt: new Date().toISOString(),
  };
}

function redisKey(channel) { return `donation-multichannel:v1:${channel}`; }
function dedupeKey(channel, platform, providerId) {
  return `donation-multichannel:v1:dedupe:${channel}:${platform}:${providerId}`;
}

app.post("/api/webhook/:platform/:accountId", async (req, res) => {
  const { platform, accountId } = req.params;
  const account = getAccount(accountId);
  if (!PLATFORM_NAMES.has(platform) || !account) return res.status(404).json({ ok: false, reason: "Unknown route" });
  if (!authenticate(req, account, "webhook")) return res.status(401).json({ ok: false, reason: "Unauthorized" });

  const donation = normalizeDonation(platform, req.body);
  if (!donation) return res.status(400).json({ ok: false, reason: "Invalid or zero-amount donation" });

  try {
    // Provider transaction IDs make retries idempotent. Timestamp fallback is unique per request.
    const providerId = donation.providerId || crypto.createHash("sha256").update(JSON.stringify(req.body)).digest("hex");
    const dedupe = dedupeKey(account.channel, platform, providerId);
    const first = await redis.set(dedupe, "1", { nx: true, ex: MAX_AGE_SECONDS });
    if (first !== "OK" && first !== true) return res.json({ ok: true, duplicate: true });

    const score = Date.now();
    donation.id = String(score);
    donation.accountId = accountId;
    await redis.zadd(redisKey(account.channel), { score, member: JSON.stringify(donation) });
    await redis.zremrangebyscore(redisKey(account.channel), "-inf", score - MAX_AGE_SECONDS * 1000);
    return res.json({ ok: true, id: donation.id });
  } catch (error) {
    console.error("[webhook] Redis error:", error.message);
    return res.status(500).json({ ok: false, reason: "Storage error" });
  }
});

function pollAccount(req, res) {
  const account = getAccount(req.params.accountId);
  if (!account) return null;
  if (!authenticate(req, account, "poll")) { res.status(401).json({ ok: false, reason: "Unauthorized" }); return null; }
  return account;
}

app.get("/api/tail/:accountId", async (req, res) => {
  const account = pollAccount(req, res); if (!account) return;
  try {
    const result = await redis.zrange(redisKey(account.channel), -1, -1);
    if (!result.length) return res.json({ ok: true, id: String(Date.now()) });
    const item = typeof result[0] === "string" ? JSON.parse(result[0]) : result[0];
    return res.json({ ok: true, id: String(item.id || Date.now()) });
  } catch (_) { return res.status(500).json({ ok: false, reason: "Storage error" }); }
});

app.get("/api/donations/:accountId", async (req, res) => {
  const account = pollAccount(req, res); if (!account) return;
  const after = Number(req.query.after || 0);
  if (!Number.isFinite(after) || after < 0) return res.status(400).json({ ok: false, reason: "Invalid cursor" });
  try {
    const raw = await redis.zrange(redisKey(account.channel), after + 1, "+inf", { byScore: true, limit: { offset: 0, count: MAX_ITEMS_PER_POLL } });
    const items = raw.map(item => typeof item === "string" ? JSON.parse(item) : item);
    const latestId = items.reduce((latest, item) => Math.max(latest, Number(item.id) || 0), after);
    return res.json({ ok: true, items, latestId: String(latestId) });
  } catch (_) { return res.status(500).json({ ok: false, reason: "Storage error" }); }
});

app.get("/", (req, res) => res.json({ ok: true, status: "Donation Bridge Multi-channel running", version: "1.0.0" }));

app.get("/api/test/:accountId", async (req, res) => {
  const testSecret = process.env.TEST_SECRET;
  if (!testSecret || !constantTimeEqual(req.query.testKey, testSecret)) return res.status(404).json({ ok: false });
  const account = getAccount(req.params.accountId); if (!account) return res.status(404).json({ ok: false });
  const score = Date.now();
  const donation = { id: String(score), accountId: req.params.accountId, source: String(req.query.platform || "saweria"), donorName: String(req.query.name || "TestDonor"), amount: Number(req.query.amount || 10000), currency: "IDR", message: String(req.query.msg || "Test donation") };
  if (!Number.isFinite(donation.amount) || donation.amount <= 0) return res.status(400).json({ ok: false, reason: "Invalid amount" });
  await redis.zadd(redisKey(account.channel), { score, member: JSON.stringify(donation) });
  return res.json({ ok: true, donation });
});

module.exports = app;
