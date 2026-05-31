// No2Dowry.com — backend API (single-file deploy build).
// Storage: PostgreSQL when DATABASE_URL is set (data PERSISTS across restarts);
// otherwise an in-memory store (data resets on restart — fine for local/demo).
// Everything inlined: store, auth, shield, matchmaking, routes.
import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import pg from 'pg'

// --- SECURITY: signing secret is REQUIRED. No insecure default. ---
const SECRET = process.env.NO2DOWRY_SECRET || ''
if (!SECRET || SECRET === 'dev-secret-change-me') {
  console.error('FATAL: NO2DOWRY_SECRET is not set (or is the old default). Set a strong random value in the environment before starting. Refusing to run with a forgeable secret.')
  process.exit(1)
}
const DATABASE_URL = process.env.DATABASE_URL || ''
// Admin endpoints require this token in the `x-admin-token` header. If unset, admin is fully locked.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''
// Auth tokens expire after this many days; user re-authenticates via OTP afterwards.
const TOKEN_MAX_AGE_MS = (Number(process.env.TOKEN_MAX_AGE_DAYS) || 30) * 864e5

// --- Web Push (VAPID). Optional: if keys/lib are absent, OS push is disabled but
// in-app notifications still work. Generate keys once with `npx web-push generate-vapid-keys`. ---
let webpush = null
try { webpush = (await import('web-push')).default } catch { console.warn('web-push not installed — OS push disabled (in-app notifications still work).') }
const VAPID_PUBLIC = process.env.VAPID_PUBLIC || ''
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || ''
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:no2dowry.ad2click@gmail.com'
const PUSH_LIVE = !!(webpush && VAPID_PUBLIC && VAPID_PRIVATE)
if (PUSH_LIVE) { try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE) } catch (e) { console.error('VAPID setup failed:', e.message) } }

/* ---------------- store (in-memory, optionally backed by Postgres) ---------------- */
const DB = { users: [], profiles: [], otps: [], connections: [], conversations: [], messages: [], videoDates: [], reports: [], subscriptions: [], familyInvites: [], bestieInvites: [], blocks: [], modActions: [], notifications: [], pushSubs: [], events: [], errors: [], verifications: [], favorites: [], profileViews: [], settings: [] }
const uuid = () => crypto.randomUUID()
const find = (c, fn) => DB[c].find(fn)
const filter = (c, fn) => DB[c].filter(fn)
const insert = (c, row) => { DB[c].push(row); persist(c, row); return row }
const update = (c, id, patch) => { const r = DB[c].find((x) => x.id === id); if (r) { Object.assign(r, patch); persist(c, r) } return r }
// Insert into a high-volume collection but keep only the most recent `max` rows (memory + PG bounded).
const logCapped = (c, row, max) => {
  DB[c].push(row); persist(c, row)
  while (DB[c].length > max) {
    const old = DB[c].shift()
    if (pgReady && old) pool.query('DELETE FROM kv WHERE collection=$1 AND id=$2', [c, String(old.id)]).catch(() => {})
  }
  return row
}

// Postgres persistence: load all rows on boot, write-through on every insert/update.
// Uses a simple key-value table (collection,id,jsonb) so it mirrors the in-memory store exactly.
let pool = null
let pgReady = false
function persist(coll, row) {
  if (!pgReady) return
  pool.query(
    'INSERT INTO kv(collection,id,data) VALUES($1,$2,$3) ON CONFLICT (collection,id) DO UPDATE SET data=$3',
    [coll, String(row.id), row]
  ).catch((e) => console.error('persist error:', e.message))
}
async function initStore() {
  if (!DATABASE_URL) { console.log('No DATABASE_URL — using in-memory store (data resets on restart).'); return }
  pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 })
  await pool.query('CREATE TABLE IF NOT EXISTS kv (collection text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (collection, id))')
  const res = await pool.query('SELECT collection, id, data FROM kv')
  for (const r of res.rows) { if (DB[r.collection]) DB[r.collection].push(r.data) }
  pgReady = true
  console.log('Connected to Postgres — loaded ' + res.rows.length + ' rows.')
}

/* ---------------- seed sample members ---------------- */
function seed() {
  const samples = [
    { name: 'Aarohi', age: 27, gender: 'female', city: 'Pune', occupation: 'Product Designer', interests: ['Travel', 'Books', 'Yoga', 'Startups', 'Dogs'], vq: { lifeGoals: 'marriage_1_2y', familyOutlook: 'modern_close', lifestyle: 'active', communication: 'direct_kind', pace: 'open' }, prompts: [{ q: 'A perfect Sunday is…', a: 'Filter coffee, a long walk, and no alarm.' }, { q: 'I want a partner who…', a: 'laughs easily and disagrees respectfully.' }], kundli: 'High harmony (28/36 gunas) — optional view' },
    { name: 'Vikram', age: 30, gender: 'male', city: 'Bengaluru', occupation: 'Software Engineer', interests: ['Trekking', 'Cooking', 'Cricket', 'Music'], vq: { lifeGoals: 'marriage_1_2y', familyOutlook: 'modern_close', lifestyle: 'outdoors', communication: 'direct_kind', pace: 'slow' }, prompts: [{ q: 'I geek out about…', a: 'trekking routes and badly-made chai.' }, { q: 'My ideal weekend', a: 'A hill, a tent, and no network bars.' }], kundli: 'Good match (24/36 gunas) — optional view' },
    { name: 'Neha', age: 26, gender: 'female', city: 'Pune', occupation: 'Doctor', interests: ['Art', 'Medicine', 'Travel', 'Coffee'], vq: { lifeGoals: 'marriage_1_2y', familyOutlook: 'faith_modern', lifestyle: 'balanced', communication: 'thoughtful', pace: 'slow' }, prompts: [{ q: 'I unwind by…', a: 'painting and ignoring my group chats.' }, { q: 'Family means…', a: 'Sunday lunches that go on for hours.' }], kundli: 'Very high harmony (31/36) — optional view' },
    { name: 'Rohan', age: 31, gender: 'male', city: 'Mumbai', occupation: 'Architect', interests: ['Design', 'Jazz', 'Coffee', 'Cycling'], vq: { lifeGoals: 'serious_no_rush', familyOutlook: 'modern_close', lifestyle: 'slow_living', communication: 'honest', pace: 'slow' }, prompts: [{ q: 'I could talk for hours about…', a: 'old buildings and new cities.' }, { q: 'I want a partner who…', a: 'is calm in chaos.' }], kundli: 'Balanced (22/36) — optional view' },
  ]
  for (const s of samples) {
    const id = uuid()
    insert('users', { id, phone: '+91-seed-' + s.name, created_at: new Date().toISOString(), pledge_taken_at: new Date().toISOString(), verification_status: 'verified', phone_verified: true, trust_score: 84, is_premium: false, status: 'active', slow_mode: false, is_sample: true })
    insert('profiles', { id: uuid(), user_id: id, display_name: s.name, age: s.age, gender: s.gender, city: s.city, occupation: s.occupation, interests: s.interests, values_quiz: s.vq, prompts: s.prompts, kundli: s.kundli })
  }
}

/* ---------------- auth ---------------- */
function issueToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, t: Date.now() })).toString('base64url')
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  return payload + '.' + sig
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null
  const [payload, sig] = token.split('.')
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
  // constant-time compare to avoid timing attacks
  const a = Buffer.from(sig || ''), b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let claims
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) } catch { return null }
  // reject expired tokens
  if (!claims || typeof claims.t !== 'number' || (Date.now() - claims.t) > TOKEN_MAX_AGE_MS) return null
  return claims
}
function requireAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const claims = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null)
  if (!claims) return res.status(401).json({ error: 'Unauthorized — please log in.' })
  const u = find('users', (x) => x.id === claims.uid)
  if (!u) return res.status(401).json({ error: 'Account not found — please log in again.' })
  if (u.status === 'banned') return res.status(403).json({ error: 'This account has been suspended for violating our community guidelines.' })
  // record last-active (throttled to once per 5 min to keep writes light)
  const now = Date.now()
  if (!u.last_active_at || now - new Date(u.last_active_at).getTime() > 300000) update('users', u.id, { last_active_at: new Date(now).toISOString() })
  req.userId = claims.uid
  next()
}
// Soft auth: attach req.userId if a valid token is present, but never block the request.
function optionalAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const claims = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null)
  if (claims && find('users', (x) => x.id === claims.uid && x.status !== 'banned')) req.userId = claims.uid
  next()
}

// is there a block in either direction between a and b?
const blockedBetween = (a, b) => DB.blocks.some((x) => (x.blocker === a && x.target === b) || (x.blocker === b && x.target === a))

// Record an in-app notification and (if push is live) deliver an OS push to all the user's devices.
function notify(userId, n) {
  if (!userId) return null
  const row = insert('notifications', {
    id: uuid(), user_id: userId, type: n.type || 'general',
    title: n.title || '', body: n.body || '', data: n.data || {},
    read: false, created_at: new Date().toISOString(),
  })
  if (PUSH_LIVE) {
    const payload = JSON.stringify({ title: row.title, body: row.body, type: row.type, data: row.data })
    for (const s of filter('pushSubs', (x) => x.user_id === userId)) {
      webpush.sendNotification(s.subscription, payload).catch((err) => {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          DB.pushSubs = DB.pushSubs.filter((x) => x.id !== s.id)
          if (pgReady) pool.query('DELETE FROM kv WHERE collection=$1 AND id=$2', ['pushSubs', String(s.id)]).catch(() => {})
        }
      })
    }
  }
  return row
}
// throttle "profile viewed" pings: at most one per viewer→owner per hour
const lastView = new Map()
// Admin gate: requires the ADMIN_TOKEN in the x-admin-token header. Locked entirely if ADMIN_TOKEN unset.
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(403).json({ error: 'Admin access is disabled (ADMIN_TOKEN not configured).' })
  const t = req.headers['x-admin-token'] || ''
  const a = Buffer.from(String(t)), b = Buffer.from(ADMIN_TOKEN)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'Admin authentication required.' })
  next()
}

/* ---------------- rate limiting (in-memory sliding window, per IP+route) ---------------- */
const rlBuckets = new Map()
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.socket.remoteAddress || 'unknown'
    const key = ip + '|' + req.method + req.path + '|' + max + '|' + windowMs
    const now = Date.now()
    let arr = rlBuckets.get(key) || []
    arr = arr.filter((t) => now - t < windowMs)
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)))
      return res.status(429).json({ error: 'Too many requests — please slow down and try again shortly.' })
    }
    arr.push(now)
    rlBuckets.set(key, arr)
    next()
  }
}
// periodic cleanup so the map doesn't grow unbounded
setInterval(() => { const now = Date.now(); for (const [k, arr] of rlBuckets) { if (!arr.some((t) => now - t < 3600000)) rlBuckets.delete(k) } }, 600000).unref?.()

/* ---------------- dowry & harassment shield ---------------- */
const DOWRY = ['dowry', 'dahej', 'jahez', 'gift to family', 'gifts for the family', 'cash gift', 'what will you give', 'how much will you give', 'car for', 'gold for', 'expect from your family', 'in return for marriage']
const HARASS = ['send nudes', 'nude', 'sex chat', 'sexual', 'bitch', 'slut', 'i know where you live', 'shut up', 'stupid woman', 'whore']
const MONEY = /(₹|rs\.?|rupees|lakh|lakhs|crore)/i
function detect(text) {
  text = text || ''
  const t = text.toLowerCase()
  const flags = []
  let severity = 'none'
  if (DOWRY.some((w) => t.includes(w))) { flags.push('dowry_demand'); severity = 'high' }
  else if (MONEY.test(text) && /(marriage|wedding|shaadi|family)/i.test(text)) { flags.push('possible_dowry'); severity = 'low' }
  if (HARASS.some((w) => t.includes(w))) { flags.push('harassment'); severity = 'high' }
  return { flags, severity }
}

/* ---------------- matchmaking ---------------- */
const DIMS = ['lifeGoals', 'familyOutlook', 'lifestyle', 'communication', 'pace']
function overlap(a, b) { a = a || []; b = b || []; if (!a.length || !b.length) return 0; const sb = new Set(b); return a.filter((x) => sb.has(x)).length / Math.max(a.length, b.length) }
// Normalize any gender spelling to 'male' / 'female' (or '' if unknown / non-binary).
// Accepts: male/man/m, female/woman/f. Used for strict matrimony opposite-gender matching.
function normGender(g) {
  const s = String(g || '').trim().toLowerCase()
  if (s === 'm' || s.startsWith('male') || s.startsWith('man')) return 'male'
  if (s === 'f' || s === 'w' || s.startsWith('female') || s.startsWith('woman')) return 'female'
  return ''
}
const oppositeGender = (g) => { const n = normGender(g); return n === 'male' ? 'female' : n === 'female' ? 'male' : null }

function scorePair(me, other) {
  const mv = me.values_quiz || {}, ov = other.values_quiz || {}
  let sum = 0
  const same = []
  for (const d of DIMS) { if (mv[d] && ov[d]) { if (mv[d] === ov[d]) { sum += 1; same.push(d) } else sum += 0.45 } else sum += 0.5 }
  const dim = sum / DIMS.length
  const inter = overlap(me.interests, other.interests)
  const compat = Math.round(60 + (0.7 * dim + 0.3 * inter) * 39)
  const label = { lifeGoals: 'want the same things from the next few years', familyOutlook: 'share a modern-but-family-close outlook', lifestyle: 'live at a similar rhythm', communication: 'communicate in a similar way', pace: 'want to move at a similar pace' }
  const why = []
  same.slice(0, 2).forEach((d) => why.push('You both ' + label[d]))
  const shared = (me.interests || []).filter((x) => (other.interests || []).includes(x))
  if (shared.length) why.push('Shared interests: ' + shared.slice(0, 3).join(', '))
  if (!why.length) why.push('A balanced match worth exploring')
  return { compat, reasons: why }
}

/* ---------------- profile schema & completeness ---------------- */
// Allowlisted profile fields we store, each with a weight toward the 0–100 completeness score.
const PROFILE_FIELDS = {
  // Core (≈25)
  display_name: 4, gender: 3, dob: 2, age: 2, height_cm: 2, weight_kg: 1, marital_status: 3,
  religion: 2, community: 1, mother_tongue: 2, nationality: 1, country: 1, state: 1, city: 2,
  // Education (≈8)
  qualification: 4, college: 2, education_field: 2,
  // Career (≈10)
  occupation: 4, company: 2, industry: 2, income_range: 2,
  // Lifestyle (≈10)
  diet: 3, smoking: 2, drinking: 2, fitness: 2, pets: 1,
  // Family (≈7)
  family_type: 3, family_values: 3, siblings: 1,
  // Photos + Video + Personality + about
  photos: 6, video_intro: 4, personality: 3, interests: 4, hobbies: 2, about_me: 3,
  // Marriage preferences (≈10)
  pref_age_min: 2, pref_age_max: 2, pref_religion: 2, pref_location: 2, pref_education: 1, pref_occupation: 1,
  // Relationship expectations (≈8)
  looking_for: 3, ready_to_marry_in: 3, relocation: 2,
  // Anti-dowry commitment (≈5)
  dowry_free_commitment: 5,
  // Social verification connections (boost trust/completeness)
  google_connected: 3, linkedin_connected: 3, facebook_connected: 2,
  // Reflective questions (≈5)
  q_marriage_meaning: 2, q_ideal_partner: 1, q_life_goals: 1, q_family_env: 1,
}
const PROFILE_KEYS = Object.keys(PROFILE_FIELDS).concat(['values_quiz', 'prompts'])
const filled = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)
function computeCompleteness(p) {
  if (!p) return 0
  let got = 0, total = 0
  for (const [k, w] of Object.entries(PROFILE_FIELDS)) { total += w; if (filled(p[k])) got += w }
  return Math.round((got / total) * 100)
}

/* ---------------- trust levels, recency, deal-breakers ---------------- */
// A human "trust level" derived from verifications, the pledge, social links & media.
function trustLevel(u, p) {
  u = u || {}; p = p || {}
  let s = 0
  if (u.phone_verified) s += 1
  if (u.verification_status === 'verified') s += 2
  if (u.pledge_taken_at) s += 1
  if (u.google_connected || u.linkedin_connected || u.facebook_connected) s += 1
  if (p.photos && p.photos.length) s += 1
  if (p.video_intro) s += 1
  let level = 0, label = 'New member'
  if (s >= 6) { level = 4; label = 'Gold — fully verified' }
  else if (s >= 4) { level = 3; label = 'Trusted' }
  else if (s >= 2) { level = 2; label = 'Established' }
  else if (s >= 1) { level = 1; label = 'Getting started' }
  return { level, label, points: s }
}
const NEW_MEMBER_MS = 7 * 864e5
const isNewMember = (u) => !!(u && u.created_at && (Date.now() - new Date(u.created_at).getTime()) < NEW_MEMBER_MS)
// Last-active label, suppressed when the member has hidden their activity.
function activeLabel(u, p) {
  if (!u || !u.last_active_at) return null
  if (p && p.hide_activity) return null
  const ms = Date.now() - new Date(u.last_active_at).getTime()
  if (ms < 10 * 60000) return 'Active now'
  if (ms < 864e5) return 'Active today'
  if (ms < 3 * 864e5) return 'Active recently'
  if (ms < 7 * 864e5) return 'Active this week'
  return null
}
// Does `other` satisfy `me`'s hard deal-breakers? Only filters when both sides have the relevant field.
function passesDealBreakers(me, other) {
  const d = me.deal_breakers
  if (!d || typeof d !== 'object') return true
  if (d.veg_only && other.diet && /non-veg|eggetarian/i.test(String(other.diet))) return false
  if (d.no_smoking && other.smoking && /yes|occasional/i.test(String(other.smoking))) return false
  if (d.no_drinking && other.drinking && /yes|social/i.test(String(other.drinking))) return false
  if (d.same_religion && me.religion && other.religion && String(me.religion).toLowerCase() !== String(other.religion).toLowerCase()) return false
  return true
}

/* ---------------- app ---------------- */
const app = express()
app.set('trust proxy', 1) // Render is behind a proxy — needed for correct client IPs in rate limiting
// CORS: allow only our own origins (comma-separated env, sensible defaults).
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || 'https://app.no2dowry.com,https://no2dowry.com,https://www.no2dowry.com,https://no2dowry.netlify.app').split(',').map((s) => s.trim()).filter(Boolean)
app.use(cors({
  origin(origin, cb) {
    // allow same-origin/no-origin (mobile WebView, curl, health checks) and our allowlisted web origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    return cb(new Error('Not allowed by CORS'))
  },
}))
app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('X-Frame-Options', 'DENY'); next() })

const inConvo = (c, uid) => c && (c.user_a === uid || c.user_b === uid)

app.get('/v1/health', (req, res) => res.json({ ok: true, service: 'no2dowry-api', version: '2.6.0-config', storage: pgReady ? 'postgres' : 'memory', auth_mode: AUTH_MODE, otp: SMS_LIVE ? 'sms' : (OTP_LIVE ? 'whatsapp' : 'demo'), social: { google: !!GOOGLE_CLIENT_ID, linkedin: !!LINKEDIN_CLIENT_ID, facebook: !!FACEBOOK_APP_ID }, push: PUSH_LIVE ? 'on' : 'off', maintenance: CONFIG.maintenance, adminLocked: !!ADMIN_TOKEN, time: new Date().toISOString() }))

// ---- OTP provider: MSG91 (WhatsApp primary + SMS fallback) with demo fallback ----
// Set these env vars to go live: MSG91_AUTHKEY and MSG91_OTP_TEMPLATE_ID.
// Channel order (WhatsApp then SMS) is configured on the MSG91 OTP template/settings.
// Until the keys are set, OTP runs in DEMO mode (fixed code 7291) so the app keeps working.
// --- SMS OTP via a generic HTTP SMS gateway (streaminbox/Vduit). We generate, store & verify
// the code ourselves; the gateway only delivers the text. Set these env vars to go live:
//   SMS_APIKEY (secret), SMS_SENDERID (6-char DLT sender), SMS_TEMPLATE_ID (DLT template id),
//   SMS_TEMPLATE (must match your DLT-registered text; use {OTP} where the code goes).
const SMS_APIKEY = process.env.SMS_APIKEY || ''
const SMS_SENDERID = process.env.SMS_SENDERID || ''
const SMS_TEMPLATE_ID = process.env.SMS_TEMPLATE_ID || ''
const SMS_API_URL = process.env.SMS_API_URL || 'http://mysms.streaminbox.in/vb/apikey.php'
const SMS_TEMPLATE = process.env.SMS_TEMPLATE || 'Your No2Dowry verification code is {OTP}. Valid for 10 minutes. Do not share it with anyone.'
const SMS_LIVE = !!(SMS_APIKEY && SMS_SENDERID)
// AUTH_MODE controls phone verification: 'otp_disabled' (phone required, no code — beta unblocker),
// 'otp_demo' (fixed code 7291), 'otp_production' (real SMS via gateway).
// The ENV value is the baseline; the admin panel can override it at runtime (persisted in the DB).
const ENV_AUTH_MODE = (process.env.AUTH_MODE || 'otp_disabled').toLowerCase()
let AUTH_MODE = ENV_AUTH_MODE
// Social login: set each provider's client id to enable it (Google works with just the public client id;
// LinkedIn/Facebook also need their server OAuth set up). Each activates by config only.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID || ''
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || ''
// legacy MSG91 fallback (kept for compatibility)
const MSG91_AUTHKEY = process.env.MSG91_AUTHKEY || ''
const MSG91_OTP_TEMPLATE_ID = process.env.MSG91_OTP_TEMPLATE_ID || ''
const OTP_LIVE = SMS_LIVE || !!(MSG91_AUTHKEY && MSG91_OTP_TEMPLATE_ID)
const OTP_TTL_MS = 10 * 60000

/* ---------------- runtime app config (admin-controllable feature flags) ----------------
 * Secrets stay in env (keys, tokens, DB url). The admin panel only flips SWITCHES, which are
 * persisted to the DB so they survive restarts. Every flag has a safe default so a missing /
 * malformed config never breaks the app. */
const CONFIG_DEFAULTS = {
  auth_mode: '',            // '' = use ENV_AUTH_MODE; else override (otp_disabled|otp_demo|otp_production)
  providers: { google: true, linkedin: true, facebook: true }, // ANDed with whether env has the credential
  features: { shortlist: true, video_intro: true, family_managed: true, deal_breakers: true, new_member_boost: true, profile_views: true, completion_nudges: true, push: true, slow_mode: true },
  daily_match_count: 4,
  require_photo: false,     // members must add a photo before they can browse matches
  require_pledge: false,    // members must take the pledge before they can browse matches
  auto_verify: false,       // selfies are auto-approved (use only when no human reviewer is available)
  maintenance: false,       // pause new sign-ups + show a banner; existing members keep working
  maintenance_message: '',
}
let CONFIG = JSON.parse(JSON.stringify(CONFIG_DEFAULTS))
const FLAG_KEYS = Object.keys(CONFIG_DEFAULTS.features)
// Merge a partial/over object over a base, keeping only recognised keys with valid types/ranges.
function mergeConfig(base, over) {
  const out = JSON.parse(JSON.stringify(base))
  if (!over || typeof over !== 'object') return out
  if (typeof over.auth_mode === 'string') out.auth_mode = ['', 'otp_disabled', 'otp_demo', 'otp_production'].includes(over.auth_mode) ? over.auth_mode : out.auth_mode
  if (over.providers) for (const k of ['google', 'linkedin', 'facebook']) if (typeof over.providers[k] === 'boolean') out.providers[k] = over.providers[k]
  if (over.features) for (const k of FLAG_KEYS) if (typeof over.features[k] === 'boolean') out.features[k] = over.features[k]
  if (Number.isFinite(Number(over.daily_match_count))) out.daily_match_count = Math.max(1, Math.min(10, Math.round(Number(over.daily_match_count))))
  for (const k of ['require_photo', 'require_pledge', 'auto_verify', 'maintenance']) if (typeof over[k] === 'boolean') out[k] = over[k]
  if (typeof over.maintenance_message === 'string') out.maintenance_message = over.maintenance_message.slice(0, 300)
  return out
}
function applyAuthMode() {
  const m = (CONFIG.auth_mode || ENV_AUTH_MODE).toLowerCase()
  AUTH_MODE = ['otp_disabled', 'otp_demo', 'otp_production'].includes(m) ? m : ENV_AUTH_MODE
}
function loadConfig() {
  const row = find('settings', (s) => s.id === 'app')
  if (row && row.data) CONFIG = mergeConfig(CONFIG_DEFAULTS, row.data)
  applyAuthMode()
}
function saveConfig() {
  const row = find('settings', (s) => s.id === 'app')
  if (row) { row.data = CONFIG; update('settings', row.id, row) }
  else insert('settings', { id: 'app', data: CONFIG })
}
// A provider is available only if (a) env has its credential AND (b) the admin flag is on.
const envHasProvider = (p) => ({ google: !!GOOGLE_CLIENT_ID, linkedin: !!LINKEDIN_CLIENT_ID, facebook: !!FACEBOOK_APP_ID }[p])
const providerEnabled = (p) => !!(CONFIG.providers[p] && envHasProvider(p))

const genCode = () => String(Math.floor(100000 + Math.random() * 900000))
const toMobile = (p) => { const d = String(p).replace(/\D/g, ''); return d.length === 10 ? '91' + d : d }
const setOtp = (phone, code) => { const ex = find('otps', (o) => o.phone === phone); if (ex) { ex.code = code; ex.t = Date.now(); persist('otps', ex) } else insert('otps', { id: uuid(), phone, code, t: Date.now() }) }

async function otpSend(phone) {
  // otp_disabled: phone is still required, but no code is sent or checked (beta unblocker).
  if (AUTH_MODE === 'otp_disabled') return { sent: true, channel: 'disabled', mode: 'otp_disabled' }
  // otp_demo: fixed code, no real SMS.
  if (AUTH_MODE === 'otp_demo') { setOtp(phone, '7291'); return { sent: true, devCode: '7291', channel: 'demo' } }
  // otp_production: real SMS via gateway (or MSG91 fallback).
  if (SMS_LIVE) {
    const code = genCode()
    setOtp(phone, code)
    const msg = SMS_TEMPLATE.replace(/\{OTP\}|\{#var#\}/g, code)
    const url = SMS_API_URL + '?apikey=' + encodeURIComponent(SMS_APIKEY) + '&senderid=' + encodeURIComponent(SMS_SENDERID) +
      '&number=' + toMobile(phone) + '&message=' + encodeURIComponent(msg) +
      (SMS_TEMPLATE_ID ? '&templateid=' + encodeURIComponent(SMS_TEMPLATE_ID) : '') + '&format=json'
    const r = await fetch(url)
    const data = await r.json().catch(() => ({}))
    if (data.status === 'Success' || data.code === '011') return { sent: true, channel: 'sms' }
    throw new Error(data.description || data.message || ('SMS gateway error ' + (data.code || '')))
  }
  if (MSG91_AUTHKEY && MSG91_OTP_TEMPLATE_ID) {
    const url = 'https://control.msg91.com/api/v5/otp?template_id=' + encodeURIComponent(MSG91_OTP_TEMPLATE_ID) +
      '&mobile=' + toMobile(phone) + '&otp_expiry=10&realTimeResponse=1'
    const r = await fetch(url, { method: 'POST', headers: { authkey: MSG91_AUTHKEY, 'Content-Type': 'application/json' }, body: '{}' })
    const data = await r.json().catch(() => ({}))
    if (data.type === 'success' || r.ok) return { sent: true, channel: 'whatsapp+sms' }
    throw new Error(data.message || 'OTP send failed')
  }
  // otp_production but no SMS provider configured
  throw new Error('OTP provider not configured. Set SMS_* env or switch AUTH_MODE.')
}
async function otpVerify(phone, code) {
  // otp_disabled: accept without a code (phone-only registration).
  if (AUTH_MODE === 'otp_disabled') return true
  if (AUTH_MODE === 'otp_demo') { const rec = find('otps', (o) => o.phone === phone); return !!(rec && rec.code === String(code).trim()) }
  if (SMS_LIVE) {
    const rec = find('otps', (o) => o.phone === phone)
    if (!rec || !rec.code) return false
    if (rec.t && Date.now() - rec.t > OTP_TTL_MS) return false
    return rec.code === String(code).trim()
  }
  if (MSG91_AUTHKEY && MSG91_OTP_TEMPLATE_ID) {
    const url = 'https://control.msg91.com/api/v5/otp/verify?otp=' + encodeURIComponent(code) + '&mobile=' + toMobile(phone)
    const r = await fetch(url, { headers: { authkey: MSG91_AUTHKEY } })
    const data = await r.json().catch(() => ({}))
    return data.type === 'success'
  }
  const rec = find('otps', (o) => o.phone === phone)
  return !!(rec && rec.code === String(code))
}

app.post('/v1/auth/otp', rateLimit(5, 60000), rateLimit(20, 864e5), async (req, res) => {
  const { phone } = req.body || {}
  if (!phone) return res.status(400).json({ error: 'phone required' })
  try {
    const r = await otpSend(phone)
    res.json({ ok: true, ...r })
  } catch (e) { res.status(502).json({ error: 'Could not send code: ' + e.message }) }
})
app.post('/v1/auth/verify', rateLimit(10, 60000), async (req, res) => {
  const { phone, code } = req.body || {}
  if (!phone) return res.status(400).json({ error: 'phone required' })
  if (AUTH_MODE !== 'otp_disabled' && !code) return res.status(400).json({ error: 'code required' })
  let ok = false
  try { ok = await otpVerify(phone, code) } catch (e) { return res.status(502).json({ error: 'Verify failed: ' + e.message }) }
  if (!ok) return res.status(401).json({ error: 'Invalid code' })
  // In otp_disabled the phone is captured but NOT verified; in demo/production a passed code = verified.
  const verified = AUTH_MODE !== 'otp_disabled'
  // Match by normalized digits so "+91 98…", "98…", "9198…" all map to ONE account (no duplicates).
  const norm = toMobile(phone)
  let user = find('users', (u) => toMobile(u.phone) === norm)
  if (!user && CONFIG.maintenance) return res.status(503).json({ error: CONFIG.maintenance_message || 'New sign-ups are paused right now. Please check back soon.' })
  if (!user) user = insert('users', { id: uuid(), phone, created_at: new Date().toISOString(), pledge_taken_at: null, verification_status: 'unverified', phone_verified: verified, phone_verified_at: verified ? new Date().toISOString() : null, google_connected: false, linkedin_connected: false, facebook_connected: false, social_ids: {}, trust_score: 42, is_premium: false, status: 'active', slow_mode: false })
  else if (verified && !user.phone_verified) update('users', user.id, { phone_verified: true, phone_verified_at: new Date().toISOString() })
  res.json({ ok: true, token: issueToken(user.id), user: find('users', (u) => u.id === user.id) })
})

// What auth methods the client should offer (drives the login UI). Public.
app.get('/v1/auth/config', (req, res) => res.json({
  ok: true, auth_mode: AUTH_MODE,
  google_client_id: providerEnabled('google') ? GOOGLE_CLIENT_ID : null,
  providers: { google: providerEnabled('google'), linkedin: providerEnabled('linkedin'), facebook: providerEnabled('facebook') },
}))

// Full public runtime config: feature flags + maintenance the app reads on load. Public (no secrets).
app.get('/v1/config', (req, res) => res.json({
  ok: true, auth_mode: AUTH_MODE,
  providers: { google: providerEnabled('google'), linkedin: providerEnabled('linkedin'), facebook: providerEnabled('facebook') },
  google_client_id: providerEnabled('google') ? GOOGLE_CLIENT_ID : null,
  features: CONFIG.features, daily_match_count: CONFIG.daily_match_count,
  require_photo: CONFIG.require_photo, require_pledge: CONFIG.require_pledge,
  maintenance: CONFIG.maintenance, maintenance_message: CONFIG.maintenance_message,
}))

// --- Admin: read & write the runtime config (feature flags). Behind the admin token. ---
app.get('/v1/admin/config', requireAdmin, (req, res) => res.json({
  ok: true, config: CONFIG,
  // what the environment supports — so the UI can grey out toggles whose secret isn't configured
  env: { auth_mode: ENV_AUTH_MODE, google: !!GOOGLE_CLIENT_ID, linkedin: !!LINKEDIN_CLIENT_ID, facebook: !!FACEBOOK_APP_ID, sms: SMS_LIVE, push: PUSH_LIVE },
}))
app.put('/v1/admin/config', requireAdmin, (req, res) => {
  CONFIG = mergeConfig(CONFIG, req.body || {}) // merge over current; only valid keys are applied
  applyAuthMode(); saveConfig()
  insert('modActions', { id: uuid(), kind: 'config_update', at: new Date().toISOString() })
  res.json({ ok: true, config: CONFIG })
})

// Verify a social credential → { sub, email, name } or null if that provider isn't configured.
async function verifySocial(provider, credential) {
  // Non-production test hook so the social account/link logic can be exercised without real OAuth apps.
  if (AUTH_MODE !== 'otp_production' && typeof credential === 'string' && credential.startsWith('devtest|')) {
    const [, email, name] = credential.split('|')
    return { sub: provider + ':' + email, email, name: name || email }
  }
  if (provider === 'google') {
    if (!GOOGLE_CLIENT_ID) return null
    if (!credential) throw new Error('Missing Google credential')
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential))
    const d = await r.json().catch(() => ({}))
    if (!d.sub || d.aud !== GOOGLE_CLIENT_ID) throw new Error('Invalid Google token')
    return { sub: 'google:' + d.sub, email: d.email || null, name: d.name || null }
  }
  if (provider === 'linkedin') { if (!LINKEDIN_CLIENT_ID) return null; throw new Error('LinkedIn login needs server OAuth (code exchange) — not finished yet.') }
  if (provider === 'facebook') { if (!FACEBOOK_APP_ID) return null; throw new Error('Facebook login needs server OAuth — not finished yet.') }
  return null
}
function connectProvider(userId, provider, sub) {
  const u = find('users', (x) => x.id === userId); if (!u) return
  const ids = u.social_ids || {}; ids[provider] = sub
  const patch = { social_ids: ids }; patch[provider + '_connected'] = true
  update('users', u.id, patch)
  const p = find('profiles', (x) => x.user_id === userId)
  if (p) { p[provider + '_connected'] = true; p.completeness = computeCompleteness(p); update('profiles', p.id, p) }
}
// Social sign-up / sign-in / re-login / account-linking. If authenticated → links provider to that account.
app.post('/v1/auth/social', optionalAuth, rateLimit(20, 60000), async (req, res) => {
  const { provider, credential } = req.body || {}
  if (!['google', 'linkedin', 'facebook'].includes(provider)) return res.status(400).json({ error: 'Invalid provider' })
  // Admin can switch a provider off without a redeploy. (The devtest hook stays available for local testing.)
  const isDevtest = AUTH_MODE !== 'otp_production' && typeof credential === 'string' && credential.startsWith('devtest|')
  if (!isDevtest && !providerEnabled(provider)) return res.status(503).json({ error: provider + ' login is not enabled.' })
  let identity
  try { identity = await verifySocial(provider, credential) } catch (e) { return res.status(401).json({ error: e.message }) }
  if (!identity) return res.status(503).json({ error: provider + ' login is not configured yet.' })
  // Account linking (already signed in)
  if (req.userId) {
    connectProvider(req.userId, provider, identity.sub)
    return res.json({ ok: true, linked: true, token: issueToken(req.userId), user: find('users', (u) => u.id === req.userId) })
  }
  // Sign-in (existing social identity) or sign-up (new)
  let user = find('users', (u) => u.social_ids && u.social_ids[provider] === identity.sub)
  let created = false
  if (!user && CONFIG.maintenance) return res.status(503).json({ error: CONFIG.maintenance_message || 'New sign-ups are paused right now. Please check back soon.' })
  if (!user) {
    user = insert('users', { id: uuid(), phone: null, email: identity.email || null, created_at: new Date().toISOString(), pledge_taken_at: null, verification_status: 'unverified', phone_verified: false, google_connected: false, linkedin_connected: false, facebook_connected: false, social_ids: {}, trust_score: 42, is_premium: false, status: 'active', slow_mode: false })
    if (identity.name) insert('profiles', { id: uuid(), user_id: user.id, display_name: identity.name })
    created = true
  }
  if (user.status === 'banned') return res.status(403).json({ error: 'This account has been suspended.' })
  connectProvider(user.id, provider, identity.sub)
  res.json({ ok: true, created, token: issueToken(user.id), user: find('users', (u) => u.id === user.id), needs_phone: !user.phone })
})

app.get('/v1/me', requireAuth, (req, res) => res.json({ ok: true, user: find('users', (u) => u.id === req.userId) }))
app.post('/v1/pledge', requireAuth, (req, res) => {
  const u = find('users', (x) => x.id === req.userId)
  if (u.pledge_taken_at) return res.json({ ok: true, user: u })
  update('users', u.id, { pledge_taken_at: new Date().toISOString(), trust_score: Math.min(100, u.trust_score + 12) })
  res.json({ ok: true, user: u })
})
// Submit a selfie for human review. Selfie is a compressed data URL; stored only until reviewed.
app.post('/v1/verification/selfie', requireAuth, rateLimit(5, 3600000), (req, res) => {
  const { image } = req.body || {}
  if (!image || typeof image !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(image)) {
    return res.status(400).json({ error: 'A selfie image is required.' })
  }
  if (image.length > 700000) return res.status(413).json({ error: 'Image too large — please retake (it should compress automatically).' })
  const u = find('users', (x) => x.id === req.userId)
  // clear any earlier pending verification for this user
  const prior = filter('verifications', (v) => v.user_id === req.userId && v.status === 'pending')
  for (const p of prior) { DB.verifications = DB.verifications.filter((x) => x.id !== p.id); if (pgReady) pool.query('DELETE FROM kv WHERE collection=$1 AND id=$2', ['verifications', String(p.id)]).catch(() => {}) }
  // Auto-verify mode (admin): approve immediately when no human reviewer is available. Selfie not retained.
  if (CONFIG.auto_verify) {
    const row = insert('verifications', { id: uuid(), user_id: req.userId, type: 'selfie', status: 'approved', selfie: null, auto: true, created_at: new Date().toISOString(), reviewed_at: new Date().toISOString() })
    update('users', u.id, { verification_status: 'verified', verified_at: new Date().toISOString(), trust_score: Math.min(100, (u.trust_score || 42) + 20) })
    notify(u.id, { type: 'verification', title: '✅ You are verified!', body: 'Your identity check passed. Your profile now shows the Verified badge.', data: {} })
    return res.json({ ok: true, status: 'approved', verification: { id: row.id, status: 'approved' } })
  }
  const row = insert('verifications', { id: uuid(), user_id: req.userId, type: 'selfie', status: 'pending', selfie: image, created_at: new Date().toISOString() })
  update('users', u.id, { verification_status: 'pending' })
  res.json({ ok: true, status: 'pending', verification: { id: row.id, status: 'pending' } })
})
app.get('/v1/verification/status', requireAuth, (req, res) => {
  const u = find('users', (x) => x.id === req.userId)
  res.json({ ok: true, phone_verified: !!u.phone_verified, verification_status: u.verification_status || 'unverified', verified: u.verification_status === 'verified' })
})
// DPDP right-to-erasure: delete the member's account and their data (memory + Postgres).
// Permanently remove a user and everything tied to them (profiles, connections,
// conversations+messages, blocks, reports, notifications, push subs, etc.).
function purgeUser(uid) {
  const convoIds = filter('conversations', (c) => c.user_a === uid || c.user_b === uid).map((c) => c.id)
  const isMine = (row) => row.user_id === uid || row.id === uid || row.from_user === uid || row.to_user === uid ||
    row.requester === uid || row.recipient === uid || row.sender === uid || row.reporter === uid ||
    row.blocker === uid || row.target === uid || row.target_user === uid || row.owner === uid || row.viewer === uid ||
    row.user_a === uid || row.user_b === uid || (row.conversation_id && convoIds.includes(row.conversation_id))
  for (const coll of Object.keys(DB)) {
    const removed = DB[coll].filter(isMine)
    DB[coll] = DB[coll].filter((r) => !isMine(r))
    if (pgReady) {
      for (const r of removed) {
        pool.query('DELETE FROM kv WHERE collection=$1 AND id=$2', [coll, String(r.id)]).catch((e) => console.error('delete error:', e.message))
      }
    }
  }
}
app.post('/v1/account/delete', requireAuth, (req, res) => {
  purgeUser(req.userId)
  res.json({ ok: true, deleted: true })
})
app.post('/v1/slow-mode', requireAuth, (req, res) => {
  const u = find('users', (x) => x.id === req.userId)
  update('users', u.id, { slow_mode: !u.slow_mode })
  res.json({ ok: true, slow_mode: u.slow_mode })
})

app.get('/v1/profile', requireAuth, (req, res) => res.json({ ok: true, profile: find('profiles', (p) => p.user_id === req.userId) }))
// Completion nudges: the highest-value fields the member hasn't filled yet (drives "complete your profile" prompts).
const NUDGE_LABELS = { photos: 'Add profile photos', video_intro: 'Record a video intro', about_me: 'Write your “About me”', dowry_free_commitment: 'Take the dowry-free commitment', occupation: 'Add your occupation', qualification: 'Add your education', religion: 'Add your religion', city: 'Add your city', height_cm: 'Add your height', diet: 'Add your diet', looking_for: 'Say what you are looking for', ready_to_marry_in: 'Add your marriage timeline', marital_status: 'Add your marital status', mother_tongue: 'Add your mother tongue', q_marriage_meaning: 'Answer: what marriage means to you' }
app.get('/v1/profile/nudges', requireAuth, (req, res) => {
  const p = find('profiles', (x) => x.user_id === req.userId)
  if (!p) return res.json({ ok: true, completeness: 0, nudges: [{ field: 'profile', label: 'Build your profile to start matching', points: 100 }] })
  const nudges = []
  for (const [k, w] of Object.entries(PROFILE_FIELDS)) if (NUDGE_LABELS[k] && !filled(p[k])) nudges.push({ field: k, label: NUDGE_LABELS[k], points: w })
  nudges.sort((a, b) => b.points - a.points)
  res.json({ ok: true, completeness: computeCompleteness(p), nudges: nudges.slice(0, 6) })
})
// Discovery & privacy settings: profile visibility, hide-activity, family-managed, deal-breakers.
function settingsOf(p) { p = p || {}; return { visibility: p.visibility || 'public', hide_activity: !!p.hide_activity, managed_by: p.managed_by || 'self', family_relation: p.family_relation || '', deal_breakers: p.deal_breakers || { veg_only: false, no_smoking: false, no_drinking: false, same_religion: false } } }
app.get('/v1/settings', requireAuth, (req, res) => res.json({ ok: true, settings: settingsOf(find('profiles', (x) => x.user_id === req.userId)) }))
app.put('/v1/settings', requireAuth, (req, res) => {
  const p = find('profiles', (x) => x.user_id === req.userId)
  if (!p) return res.status(400).json({ error: 'Build your profile first.' })
  const b = req.body || {}
  if (b.visibility === 'public' || b.visibility === 'hidden') p.visibility = b.visibility
  if (typeof b.hide_activity === 'boolean') p.hide_activity = b.hide_activity
  if (b.managed_by === 'self' || b.managed_by === 'family') p.managed_by = b.managed_by
  if (typeof b.family_relation === 'string') p.family_relation = b.family_relation.slice(0, 40)
  if (b.deal_breakers && typeof b.deal_breakers === 'object') {
    const d = b.deal_breakers
    p.deal_breakers = { veg_only: !!d.veg_only, no_smoking: !!d.no_smoking, no_drinking: !!d.no_drinking, same_religion: !!d.same_religion }
  }
  update('profiles', p.id, p)
  res.json({ ok: true, settings: settingsOf(p) })
})
// Favorites / shortlist (toggle) + mutual-interest detection.
app.get('/v1/favorites', requireAuth, (req, res) => {
  const list = filter('favorites', (f) => f.user_id === req.userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .map((f) => {
      const p = find('profiles', (x) => x.user_id === f.target)
      const tu = find('users', (x) => x.id === f.target) || {}
      const mutual = !!find('favorites', (x) => x.user_id === f.target && x.target === req.userId)
      return { user_id: f.target, name: p ? p.display_name : 'Member', age: p ? p.age : null, city: p ? p.city : '', occupation: p ? p.occupation : '', photo: (p && p.photos && p.photos[0]) ? p.photos[0].url : null, trust_score: tu.trust_score, mutual, since: f.created_at }
    })
  res.json({ ok: true, favorites: list })
})
app.post('/v1/favorites', requireAuth, rateLimit(60, 60000), (req, res) => {
  if (!CONFIG.features.shortlist) return res.status(403).json({ error: 'Shortlist is currently disabled.' })
  const { target_user } = req.body || {}
  if (!target_user || target_user === req.userId) return res.status(400).json({ error: 'Invalid user' })
  const existing = find('favorites', (f) => f.user_id === req.userId && f.target === target_user)
  if (existing) {
    DB.favorites = DB.favorites.filter((f) => f.id !== existing.id)
    if (pgReady) pool.query('DELETE FROM kv WHERE collection=$1 AND id=$2', ['favorites', String(existing.id)]).catch(() => {})
    return res.json({ ok: true, favorited: false })
  }
  insert('favorites', { id: uuid(), user_id: req.userId, target: target_user, created_at: new Date().toISOString() })
  // mutual interest: the other person had already shortlisted me
  let mutual = false
  if (find('favorites', (f) => f.user_id === target_user && f.target === req.userId)) {
    mutual = true
    const meP = find('profiles', (p) => p.user_id === req.userId)
    const themP = find('profiles', (p) => p.user_id === target_user)
    const them = find('users', (u) => u.id === target_user)
    if (them && !them.is_sample) notify(target_user, { type: 'mutual_interest', title: '💞 It’s a mutual interest!', body: ((meP && meP.display_name) || 'Someone') + ' shortlisted you too — say hello!', data: {} })
    notify(req.userId, { type: 'mutual_interest', title: '💞 It’s a mutual interest!', body: ((themP && themP.display_name) || 'Your match') + ' had already shortlisted you — say hello!', data: {} })
  }
  res.json({ ok: true, favorited: true, mutual })
})
// Who viewed my profile (distinct viewers, newest first; anonymous views counted separately).
app.get('/v1/profile-views', requireAuth, (req, res) => {
  const views = filter('profileViews', (v) => v.owner === req.userId).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  const seen = new Set(); const viewers = []; let anonymous = 0
  for (const v of views) {
    if (!v.viewer) { anonymous++; continue }
    if (seen.has(v.viewer)) continue
    seen.add(v.viewer)
    const p = find('profiles', (x) => x.user_id === v.viewer)
    const vu = find('users', (x) => x.id === v.viewer) || {}
    viewers.push({ user_id: v.viewer, name: p ? p.display_name : 'Member', age: p ? p.age : null, city: p ? p.city : '', occupation: p ? p.occupation : '', photo: (p && p.photos && p.photos[0]) ? p.photos[0].url : null, trust_score: vu.trust_score, when: v.created_at })
  }
  res.json({ ok: true, viewers, anonymous, total: views.length })
})
app.put('/v1/profile', requireAuth, (req, res) => {
  const body = req.body || {}
  if (!body.display_name) return res.status(400).json({ error: 'display_name required' })
  // accept only known profile keys (ignore anything else)
  const data = {}
  for (const k of PROFILE_KEYS) if (k in body) data[k] = body[k]
  let p = find('profiles', (x) => x.user_id === req.userId)
  if (p) Object.assign(p, data)
  else p = { id: uuid(), user_id: req.userId, ...data }
  p.completeness = computeCompleteness(p)
  if (find('profiles', (x) => x.user_id === req.userId)) update('profiles', p.id, p)
  else insert('profiles', p)
  res.json({ ok: true, profile: p })
})
// Profile photos: ordered list, photos[0] = primary. Up to 7. URLs must be from our Cloudinary.
app.put('/v1/profile/photos', requireAuth, (req, res) => {
  const { photos } = req.body || {}
  if (!Array.isArray(photos)) return res.status(400).json({ error: 'photos array required' })
  const clean = photos
    .filter((ph) => ph && typeof ph.url === 'string' && /^https:\/\/res\.cloudinary\.com\//.test(ph.url))
    .slice(0, 7)
    .map((ph) => ({ url: ph.url, public_id: typeof ph.public_id === 'string' ? ph.public_id.slice(0, 200) : null }))
  let p = find('profiles', (x) => x.user_id === req.userId)
  if (!p) return res.status(400).json({ error: 'Build your profile first.' })
  p.photos = clean
  p.completeness = computeCompleteness(p)
  update('profiles', p.id, p)
  res.json({ ok: true, photos: clean, completeness: p.completeness })
})
// Profile video intro: a short clip hosted on Cloudinary. Pass url:null to remove it.
app.put('/v1/profile/video', requireAuth, (req, res) => {
  const { url, public_id } = req.body || {}
  let p = find('profiles', (x) => x.user_id === req.userId)
  if (!p) return res.status(400).json({ error: 'Build your profile first.' })
  if (url === null || url === '') {
    p.video_intro = null; p.video_intro_public_id = null
  } else {
    if (typeof url !== 'string' || !/^https:\/\/res\.cloudinary\.com\//.test(url)) return res.status(400).json({ error: 'Invalid video URL' })
    p.video_intro = url
    p.video_intro_public_id = typeof public_id === 'string' ? public_id.slice(0, 200) : null
  }
  p.completeness = computeCompleteness(p)
  update('profiles', p.id, p)
  res.json({ ok: true, video_intro: p.video_intro || null, completeness: p.completeness })
})
app.get('/v1/profile/:userId', requireAuth, (req, res) => {
  const prof = find('profiles', (p) => p.user_id === req.params.userId)
  if (!prof) return res.status(404).json({ error: 'Profile not found' })
  const u = find('users', (x) => x.id === req.params.userId) || {}
  // "Someone viewed your profile" — only for real members, not self, not blocked, throttled to 1/hour per viewer→owner
  const owner = req.params.userId
  if (CONFIG.features.profile_views && owner !== req.userId && !u.is_sample && !blockedBetween(req.userId, owner)) {
    const key = req.userId + '|' + owner
    const now = Date.now()
    if (!lastView.has(key) || now - lastView.get(key) > 3600000) {
      lastView.set(key, now)
      // If the viewer has hidden their activity, the view is recorded anonymously.
      const viewerProf = find('profiles', (x) => x.user_id === req.userId)
      const anon = !!(viewerProf && viewerProf.hide_activity)
      logCapped('profileViews', { id: uuid(), viewer: anon ? null : req.userId, owner, anon, created_at: new Date().toISOString() }, 6000)
      notify(owner, { type: 'profile_view', title: '👀 Someone viewed your profile', body: (anon ? 'A member' : ((viewerProf && viewerProf.display_name) || 'A member')) + ' just checked out your profile.', data: {} })
    }
  }
  const fav = !!find('favorites', (f) => f.user_id === req.userId && f.target === owner)
  const tl = trustLevel(u, prof)
  res.json({ ok: true, profile: { user_id: prof.user_id, display_name: prof.display_name, age: prof.age, city: prof.city, occupation: prof.occupation, interests: prof.interests || [], prompts: prof.prompts || [], kundli: prof.kundli || null, trust_score: u.trust_score, verified: u.verification_status === 'verified', phone_verified: !!u.phone_verified, pledged: !!u.pledge_taken_at, photos: prof.photos || [], video_intro: prof.video_intro || null, trust_level: tl.label, trust_level_n: tl.level, is_new: isNewMember(u), active: activeLabel(u, prof), managed_by: prof.managed_by || 'self', family_relation: prof.family_relation || '', favorited: fav } })
})

// MATRIMONY DISCOVERY — strict opposite-gender matching (see CORE MATRIMONY MATCHING RULES).
// This is the single discovery surface (Discover / recommendations / suggested all use it).
app.get('/v1/matches/today', requireAuth, (req, res) => {
  const me = find('profiles', (p) => p.user_id === req.userId)
  if (!me) return res.status(400).json({ error: 'Build your profile first.' })
  const u = find('users', (x) => x.id === req.userId)
  // Admin-controlled gates: members may need a photo / the pledge before they can browse.
  if (CONFIG.require_photo && !(me.photos && me.photos.length)) return res.json({ ok: true, date: new Date().toISOString().slice(0, 10), matches: [], needs_photo: true, message: 'Add a profile photo to start seeing matches.' })
  if (CONFIG.require_pledge && !(u && u.pledge_taken_at)) return res.json({ ok: true, date: new Date().toISOString().slice(0, 10), matches: [], needs_pledge: true, message: 'Take the dowry-free pledge to start seeing matches.' })
  const limit = (u && u.slow_mode && CONFIG.features.slow_mode) ? 2 : CONFIG.daily_match_count
  // RULE 1 + RULE 5: target gender is the opposite of the viewer's gender (future: read a preference).
  const target = oppositeGender(me.gender)
  if (!target) return res.json({ ok: true, date: new Date().toISOString().slice(0, 10), matches: [], needs_gender: true, message: 'Add your gender to your profile to see matches.' })
  // RULE 2: eligibility — opposite gender, active, not banned, not blocked, not self.
  const eligible = filter('profiles', (p) => {
    if (p.user_id === req.userId) return false
    if (normGender(p.gender) !== target) return false
    if (p.visibility === 'hidden') return false // member hid their profile from discovery
    if (blockedBetween(req.userId, p.user_id)) return false
    const pu = find('users', (x) => x.id === p.user_id)
    if (!pu || pu.status === 'banned') return false
    if (CONFIG.features.deal_breakers && !passesDealBreakers(me, p)) return false // viewer's hard deal-breakers
    return true
  })
  // RULE 4 (profile quality) + RULE 3 (matrimony priorities) — ranking weight; does not change shown compat %.
  const rank = (o) => {
    const ou = find('users', (x) => x.id === o.user_id) || {}
    let r = 0
    if (computeCompleteness(o) >= 80) r += 1000
    if (ou.verification_status === 'verified') r += 300
    if (o.photos && o.photos.length) r += 200
    if (o.video_intro) r += 150
    if (ou.pledge_taken_at) r += 150
    if (me.age && o.age && Math.abs(Number(me.age) - Number(o.age)) <= 5) r += 120
    if (me.religion && o.religion && me.religion === o.religion) r += 100
    if (me.city && o.city && me.city === o.city) r += 80
    if ((me.values_quiz || {}).lifeGoals && (o.values_quiz || {}).lifeGoals === (me.values_quiz || {}).lifeGoals) r += 60
    if (o.relocation && /yes|open|will/i.test(String(o.relocation))) r += 40
    if (CONFIG.features.new_member_boost && isNewMember(ou)) r += 90 // new-member boost: give fresh joiners early visibility
    return r
  }
  const myFavs = new Set(filter('favorites', (f) => f.user_id === req.userId).map((f) => f.target))
  const matches = eligible.map((o) => ({ o, ...scorePair(me, o) }))
    .sort((a, b) => (b.compat + rank(b.o)) - (a.compat + rank(a.o)))
    .slice(0, limit).map((c) => {
      const ou = find('users', (x) => x.id === c.o.user_id) || {}
      const tl = trustLevel(ou, c.o)
      return { user_id: c.o.user_id, name: c.o.display_name, age: c.o.age, city: c.o.city, occupation: c.o.occupation, interests: c.o.interests, compatibility_score: c.compat, reasons: c.reasons, trust_score: ou.trust_score, photo: (c.o.photos && c.o.photos[0]) ? c.o.photos[0].url : null, trust_level: tl.label, trust_level_n: tl.level, is_new: isNewMember(ou), active: activeLabel(ou, c.o), favorited: myFavs.has(c.o.user_id) }
    })
  res.json({ ok: true, date: new Date().toISOString().slice(0, 10), matches })
})

app.post('/v1/connections', requireAuth, rateLimit(30, 60000), (req, res) => {
  const { to_user, opener_message } = req.body || {}
  if (!to_user) return res.status(400).json({ error: 'to_user required' })
  if (to_user === req.userId) return res.status(400).json({ error: "You can't connect with yourself." })
  if (blockedBetween(req.userId, to_user)) return res.status(403).json({ error: 'You cannot connect with this member.' })
  const row = insert('connections', { id: uuid(), from_user: req.userId, to_user, opener_message: opener_message || '', status: 'pending', created_at: new Date().toISOString() })
  let conversation = null
  const rec = find('users', (u) => u.id === to_user)
  if (rec && rec.is_sample) {
    row.status = 'accepted'
    const pair = [req.userId, to_user].sort()
    conversation = insert('conversations', { id: uuid(), user_a: pair[0], user_b: pair[1], created_at: new Date().toISOString() })
    insert('messages', { id: uuid(), conversation_id: conversation.id, sender: to_user, body: 'Hi! So glad you reached out 😊 What made you say yes to the pledge?', shield_flags: [], shield_severity: 'none', created_at: new Date().toISOString() })
  } else {
    // notify the recipient of a new connection request
    const me = find('profiles', (p) => p.user_id === req.userId)
    notify(to_user, { type: 'connection_request', title: '💛 New connection request', body: (me ? me.display_name : 'Someone') + ' wants to connect with you.', data: { connection_id: row.id } })
  }
  res.json({ ok: true, connection: row, conversation, autoAccepted: !!conversation })
})
app.get('/v1/connections', requireAuth, (req, res) => {
  const mine = filter('connections', (c) => c.from_user === req.userId || c.to_user === req.userId).map((c) => {
    const incoming = c.to_user === req.userId
    const otherId = incoming ? c.from_user : c.to_user
    const prof = find('profiles', (p) => p.user_id === otherId)
    const u = find('users', (x) => x.id === otherId) || {}
    return {
      id: c.id, status: c.status, direction: incoming ? 'incoming' : 'outgoing',
      opener_message: c.opener_message, created_at: c.created_at,
      other: { user_id: otherId, name: prof ? prof.display_name : 'Member', city: prof ? prof.city : '', age: prof ? prof.age : null, trust_score: u.trust_score },
    }
  })
  res.json({ ok: true, connections: mine })
})
app.post('/v1/connections/:id/accept', requireAuth, (req, res) => {
  const c = find('connections', (x) => x.id === req.params.id)
  if (!c) return res.status(404).json({ error: 'Not found' })
  if (c.to_user !== req.userId) return res.status(403).json({ error: 'Only the recipient can accept.' })
  c.status = 'accepted'
  const pair = [c.from_user, c.to_user].sort()
  let convo = find('conversations', (x) => [x.user_a, x.user_b].sort().join() === pair.join())
  if (!convo) convo = insert('conversations', { id: uuid(), user_a: pair[0], user_b: pair[1], created_at: new Date().toISOString() })
  const me = find('profiles', (p) => p.user_id === req.userId)
  notify(c.from_user, { type: 'connection_accepted', title: '🎉 Connection accepted', body: (me ? me.display_name : 'Your match') + ' accepted your request — say hello!', data: { conversation_id: convo.id } })
  res.json({ ok: true, connection: c, conversation: convo })
})

app.get('/v1/conversations', requireAuth, (req, res) => {
  const mine = filter('conversations', (c) => inConvo(c, req.userId)).map((c) => {
    const otherId = c.user_a === req.userId ? c.user_b : c.user_a
    const prof = find('profiles', (p) => p.user_id === otherId)
    const msgs = filter('messages', (m) => m.conversation_id === c.id)
    return { id: c.id, other: { user_id: otherId, name: prof ? prof.display_name : 'Member' }, last: msgs.length ? msgs[msgs.length - 1].body : '' }
  })
  res.json({ ok: true, conversations: mine })
})
app.get('/v1/conversations/:id/messages', requireAuth, (req, res) => {
  const convo = find('conversations', (c) => c.id === req.params.id)
  if (!inConvo(convo, req.userId)) return res.status(403).json({ error: 'Not your conversation.' })
  res.json({ ok: true, messages: filter('messages', (m) => m.conversation_id === convo.id) })
})
app.post('/v1/conversations/:id/messages', requireAuth, rateLimit(30, 60000), (req, res) => {
  const convo = find('conversations', (c) => c.id === req.params.id)
  if (!inConvo(convo, req.userId)) return res.status(403).json({ error: 'Not your conversation.' })
  const otherInConvo = convo.user_a === req.userId ? convo.user_b : convo.user_a
  if (blockedBetween(req.userId, otherInConvo)) return res.status(403).json({ error: 'You can no longer message this member.' })
  const { body } = req.body || {}
  if (!body) return res.status(400).json({ error: 'body required' })
  const shield = detect(body)
  const msg = insert('messages', { id: uuid(), conversation_id: convo.id, sender: req.userId, body, shield_flags: shield.flags, shield_severity: shield.severity, created_at: new Date().toISOString() })
  const otherId = convo.user_a === req.userId ? convo.user_b : convo.user_a
  const other = find('users', (u) => u.id === otherId)
  if (other && other.is_sample && shield.severity !== 'high') {
    const replies = ['Haha I love that.', 'Totally agree 😄', 'Tell me more!', 'That is so me too.', 'Okay that won me over ☕']
    insert('messages', { id: uuid(), conversation_id: convo.id, sender: otherId, body: replies[Math.floor(Math.random() * replies.length)], shield_flags: [], shield_severity: 'none', created_at: new Date().toISOString() })
  } else if (other && !other.is_sample && shield.severity !== 'high') {
    // notify the real recipient of a new message
    const me = find('profiles', (p) => p.user_id === req.userId)
    notify(otherId, { type: 'message', title: '💬 ' + (me ? me.display_name : 'New message'), body: body.length > 80 ? body.slice(0, 77) + '…' : body, data: { conversation_id: convo.id } })
  }
  res.json({ ok: true, message: msg, shield, warning: shield.severity === 'high' ? 'This message was flagged by our safety shield and sent for review.' : null })
})

app.post('/v1/video-dates', requireAuth, (req, res) => {
  const { recipient, proposed_time } = req.body || {}
  if (!recipient) return res.status(400).json({ error: 'recipient required' })
  const row = insert('videoDates', { id: uuid(), requester: req.userId, recipient, proposed_time: proposed_time || null, status: 'requested', room_id: null, created_at: new Date().toISOString() })
  res.json({ ok: true, videoDate: row, note: 'Waiting for recipient approval. No call link exists yet.' })
})
app.post('/v1/video-dates/:id/approve', requireAuth, (req, res) => {
  const vd = find('videoDates', (v) => v.id === req.params.id)
  if (!vd) return res.status(404).json({ error: 'Not found' })
  if (vd.recipient !== req.userId) return res.status(403).json({ error: 'Only the recipient can approve.' })
  if (vd.status !== 'approved') update('videoDates', vd.id, { status: 'approved', room_id: 'room_' + uuid().slice(0, 8) })
  res.json({ ok: true, videoDate: vd })
})

app.post('/v1/family-circle', requireAuth, (req, res) => {
  const { contact, relation } = req.body || {}
  if (!contact) return res.status(400).json({ error: 'contact required' })
  res.json({ ok: true, invite: insert('familyInvites', { id: uuid(), user_id: req.userId, contact, relation: relation || 'family', status: 'invited', created_at: new Date().toISOString() }) })
})
app.post('/v1/bestie', requireAuth, (req, res) => {
  const { contact } = req.body || {}
  if (!contact) return res.status(400).json({ error: 'contact required' })
  res.json({ ok: true, invite: insert('bestieInvites', { id: uuid(), user_id: req.userId, contact, status: 'invited', created_at: new Date().toISOString() }) })
})

const PLANS = { premium: { name: 'No2Dowry Premium', price_inr: 499 }, elite: { name: 'Verified+ Elite', price_inr: 1499 } }
app.get('/v1/billing/plans', requireAuth, (req, res) => res.json({ ok: true, plans: PLANS }))
app.post('/v1/billing/subscribe', requireAuth, (req, res) => {
  const { plan } = req.body || {}
  if (!PLANS[plan]) return res.status(400).json({ error: 'Unknown plan' })
  const u = find('users', (x) => x.id === req.userId)
  const until = new Date(Date.now() + 30 * 864e5).toISOString()
  update('users', u.id, { is_premium: true, premium_until: until })
  res.json({ ok: true, subscription: insert('subscriptions', { id: uuid(), user_id: u.id, plan, status: 'active', current_period_end: until }) })
})

app.post('/v1/reports', requireAuth, rateLimit(20, 3600000), (req, res) => {
  const { target_user, reason, message_id, conversation_id, type } = req.body || {}
  const report = insert('reports', {
    id: uuid(), reporter: req.userId, target_user: target_user || null, message_id: message_id || null,
    conversation_id: conversation_id || null, type: type || 'user', reason: reason || 'unspecified',
    status: 'open', created_at: new Date().toISOString(),
  })
  res.json({ ok: true, report })
})

/* ---- Block / unblock ---- */
app.get('/v1/blocks', requireAuth, (req, res) => {
  res.json({ ok: true, blocks: filter('blocks', (b) => b.blocker === req.userId).map((b) => b.target) })
})
app.post('/v1/block', requireAuth, rateLimit(30, 3600000), (req, res) => {
  const { target_user } = req.body || {}
  if (!target_user || target_user === req.userId) return res.status(400).json({ error: 'Invalid user' })
  if (!find('blocks', (b) => b.blocker === req.userId && b.target === target_user)) {
    insert('blocks', { id: uuid(), blocker: req.userId, target: target_user, created_at: new Date().toISOString() })
  }
  res.json({ ok: true, blocked: true })
})
app.post('/v1/unblock', requireAuth, (req, res) => {
  const { target_user } = req.body || {}
  const b = find('blocks', (x) => x.blocker === req.userId && x.target === target_user)
  if (b) { DB.blocks = DB.blocks.filter((x) => x.id !== b.id); if (pgReady) pool.query('DELETE FROM kv WHERE collection=$1 AND id=$2', ['blocks', String(b.id)]).catch(() => {}) }
  res.json({ ok: true, unblocked: true })
})

/* ---- Notifications (in-app) ---- */
app.get('/v1/notifications', requireAuth, (req, res) => {
  const mine = filter('notifications', (n) => n.user_id === req.userId)
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, 50)
  res.json({ ok: true, notifications: mine, unread: mine.filter((n) => !n.read).length })
})
app.post('/v1/notifications/read', requireAuth, (req, res) => {
  const { ids } = req.body || {}
  const mine = filter('notifications', (n) => n.user_id === req.userId)
  const target = Array.isArray(ids) && ids.length ? mine.filter((n) => ids.includes(n.id)) : mine
  for (const n of target) if (!n.read) update('notifications', n.id, { read: true })
  res.json({ ok: true, unread: filter('notifications', (n) => n.user_id === req.userId && !n.read).length })
})

/* ---- Web Push subscriptions ---- */
app.get('/v1/push/vapid', (req, res) => res.json({ ok: true, enabled: PUSH_LIVE, publicKey: PUSH_LIVE ? VAPID_PUBLIC : null }))
app.post('/v1/push/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body || {}
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'subscription required' })
  const existing = find('pushSubs', (s) => s.user_id === req.userId && s.subscription && s.subscription.endpoint === subscription.endpoint)
  if (!existing) insert('pushSubs', { id: uuid(), user_id: req.userId, subscription, created_at: new Date().toISOString() })
  res.json({ ok: true, subscribed: true, pushEnabled: PUSH_LIVE })
})
app.post('/v1/push/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body || {}
  const gone = filter('pushSubs', (s) => s.user_id === req.userId && (!endpoint || (s.subscription && s.subscription.endpoint === endpoint)))
  DB.pushSubs = DB.pushSubs.filter((s) => !gone.includes(s))
  if (pgReady) for (const s of gone) pool.query('DELETE FROM kv WHERE collection=$1 AND id=$2', ['pushSubs', String(s.id)]).catch(() => {})
  res.json({ ok: true, unsubscribed: true })
})

/* ---- Analytics: first-party event + error ingest ---- */
const SAFE_PROP = (v) => {
  if (v == null) return v
  if (typeof v === 'number' || typeof v === 'boolean') return v
  return String(v).slice(0, 120) // cap strings; never store free-form PII blobs
}
app.post('/v1/events', optionalAuth, rateLimit(120, 60000), (req, res) => {
  const body = req.body || {}
  const list = Array.isArray(body.events) ? body.events : (body.name ? [body] : [])
  if (!list.length) return res.json({ ok: true, accepted: 0 })
  const ua = (req.headers['user-agent'] || '').slice(0, 200)
  let n = 0
  for (const e of list.slice(0, 50)) {
    if (!e || !e.name) continue
    const props = {}
    if (e.props && typeof e.props === 'object') for (const k of Object.keys(e.props).slice(0, 12)) props[k] = SAFE_PROP(e.props[k])
    logCapped('events', {
      id: uuid(), name: String(e.name).slice(0, 60), props,
      user_id: req.userId || null, anon_id: String(e.anon_id || '').slice(0, 40) || null,
      ts: e.ts && !isNaN(new Date(e.ts)) ? new Date(e.ts).toISOString() : new Date().toISOString(), ua,
    }, 8000)
    n++
  }
  res.json({ ok: true, accepted: n })
})
app.post('/v1/errors', optionalAuth, rateLimit(60, 60000), (req, res) => {
  const { message, stack, url, anon_id } = req.body || {}
  if (!message) return res.status(400).json({ error: 'message required' })
  logCapped('errors', {
    id: uuid(), message: String(message).slice(0, 300), stack: String(stack || '').slice(0, 2000),
    url: String(url || '').slice(0, 200), user_id: req.userId || null, anon_id: String(anon_id || '').slice(0, 40) || null,
    ua: (req.headers['user-agent'] || '').slice(0, 200), created_at: new Date().toISOString(),
  }, 2000)
  res.json({ ok: true })
})

app.get('/v1/admin/analytics', requireAdmin, (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7))
  const since = Date.now() - days * 864e5
  const recent = filter('events', (e) => new Date(e.ts).getTime() >= since)
  // event counts by name
  const byName = {}
  for (const e of recent) byName[e.name] = (byName[e.name] || 0) + 1
  // daily active (unique user_id or anon_id per day)
  const dau = {}
  for (const e of recent) {
    const day = e.ts.slice(0, 10)
    const who = e.user_id || e.anon_id || 'anon'
    ;(dau[day] = dau[day] || new Set()).add(who)
  }
  const dauSeries = Object.keys(dau).sort().map((d) => ({ day: d, active: dau[d].size }))
  // onboarding funnel (unique actors who fired each step)
  const FUNNEL = ['app_open', 'phone_entered', 'otp_verified', 'pledge_taken', 'identity_verified', 'profile_built', 'quiz_done', 'connect_sent']
  const funnel = FUNNEL.map((step) => {
    const actors = new Set()
    for (const e of recent) if (e.name === step) actors.add(e.user_id || e.anon_id || 'anon')
    return { step, count: actors.size }
  })
  // recent errors grouped by message
  const errs = [...DB.errors].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
  const errGroups = {}
  for (const e of errs) { const k = e.message; (errGroups[k] = errGroups[k] || { message: k, count: 0, last: e.created_at, sample: e }); errGroups[k].count++ }
  res.json({
    ok: true, days, totalEvents: recent.length, byName, dau: dauSeries, funnel,
    errorCount: DB.errors.length,
    errorGroups: Object.values(errGroups).sort((a, b) => b.count - a.count).slice(0, 30),
    recentErrors: errs.slice(0, 20).map((e) => ({ message: e.message, url: e.url, created_at: e.created_at, stack: (e.stack || '').slice(0, 400) })),
  })
})

app.get('/v1/admin/stats', requireAdmin, (req, res) => res.json({ ok: true, users: DB.users.length, verified: filter('users', (u) => u.verification_status === 'verified').length, pledged: filter('users', (u) => u.pledge_taken_at).length, premium: filter('users', (u) => u.is_premium).length, connections: DB.connections.length, conversations: DB.conversations.length, videoDates: DB.videoDates.length, openReports: filter('reports', (r) => r.status === 'open').length, pendingVerifications: filter('verifications', (v) => v.status === 'pending').length, events: DB.events.length, errors: DB.errors.length }))
app.get('/v1/admin/flagged', requireAdmin, (req, res) => res.json({ ok: true, flaggedMessages: filter('messages', (m) => (m.shield_flags || []).length && !m.removed).map((m) => ({ id: m.id, sender: m.sender, body: m.body, flags: m.shield_flags, severity: m.shield_severity })), openReports: filter('reports', (r) => r.status === 'open') }))

// helpers for moderation views
const nameOf = (uid) => { const p = find('profiles', (x) => x.user_id === uid); return p ? p.display_name : null }
const maskPhone = (ph) => (ph ? String(ph).replace(/.(?=.{3})/g, '•') : null)

// Full moderation report list (open + resolved), newest first, with names + message text
app.get('/v1/admin/reports', requireAdmin, (req, res) => {
  const reports = [...DB.reports].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map((r) => {
    const msg = r.message_id ? find('messages', (m) => m.id === r.message_id) : null
    return { ...r, reporter_name: nameOf(r.reporter), target_name: nameOf(r.target_user), message_body: msg ? msg.body : null }
  })
  res.json({ ok: true, reports })
})

// User directory for moderation (phone masked, status, trust, completeness)
app.get('/v1/admin/users', requireAdmin, (req, res) => {
  const users = [...DB.users].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map((u) => {
    const p = find('profiles', (x) => x.user_id === u.id)
    return {
      id: u.id, name: p ? p.display_name : null, phone: maskPhone(u.phone), city: p ? p.city : null,
      verified: u.verification_status === 'verified', verification_status: u.verification_status || 'unverified',
      phone_verified: !!u.phone_verified, pledged: !!u.pledge_taken_at, premium: !!u.is_premium,
      trust_score: u.trust_score, status: u.status || 'active', completeness: p ? computeCompleteness(p) : 0,
      is_sample: !!u.is_sample, created_at: u.created_at,
    }
  })
  res.json({ ok: true, users })
})

// Resolve / dismiss a report (optionally record the action taken)
app.post('/v1/admin/reports/:id/resolve', requireAdmin, (req, res) => {
  const r = find('reports', (x) => x.id === req.params.id)
  if (!r) return res.status(404).json({ error: 'Report not found' })
  const { action } = req.body || {}
  update('reports', r.id, { status: 'resolved', resolved_at: new Date().toISOString(), resolution: action || 'reviewed' })
  insert('modActions', { id: uuid(), kind: 'resolve_report', report_id: r.id, action: action || 'reviewed', at: new Date().toISOString() })
  notify(r.reporter, { type: 'report_reviewed', title: '🛡️ Your report was reviewed', body: 'Thank you for keeping No2Dowry safe. Our team has reviewed your report and taken appropriate action.', data: { report_id: r.id } })
  res.json({ ok: true, report: find('reports', (x) => x.id === r.id) })
})

// Ban / unban a user (banned users are rejected at requireAuth)
app.post('/v1/admin/users/:id/ban', requireAdmin, (req, res) => {
  const u = find('users', (x) => x.id === req.params.id)
  if (!u) return res.status(404).json({ error: 'User not found' })
  update('users', u.id, { status: 'banned', banned_at: new Date().toISOString() })
  insert('modActions', { id: uuid(), kind: 'ban', user_id: u.id, at: new Date().toISOString() })
  res.json({ ok: true, user: { id: u.id, status: 'banned' } })
})
app.post('/v1/admin/users/:id/unban', requireAdmin, (req, res) => {
  const u = find('users', (x) => x.id === req.params.id)
  if (!u) return res.status(404).json({ error: 'User not found' })
  update('users', u.id, { status: 'active', banned_at: null })
  insert('modActions', { id: uuid(), kind: 'unban', user_id: u.id, at: new Date().toISOString() })
  res.json({ ok: true, user: { id: u.id, status: 'active' } })
})
// Admin hard-delete: permanently remove a user and all their data.
app.post('/v1/admin/users/:id/delete', requireAdmin, (req, res) => {
  const u = find('users', (x) => x.id === req.params.id)
  if (!u) return res.status(404).json({ error: 'User not found' })
  purgeUser(u.id)
  insert('modActions', { id: uuid(), kind: 'delete_user', user_id: req.params.id, at: new Date().toISOString() })
  res.json({ ok: true, deleted: true })
})

// Verification review queue
app.get('/v1/admin/verifications', requireAdmin, (req, res) => {
  const pending = filter('verifications', (v) => v.status === 'pending')
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
    .map((v) => ({ id: v.id, user_id: v.user_id, name: nameOf(v.user_id), selfie: v.selfie, created_at: v.created_at }))
  res.json({ ok: true, verifications: pending })
})
app.post('/v1/admin/verifications/:id/approve', requireAdmin, (req, res) => {
  const v = find('verifications', (x) => x.id === req.params.id)
  if (!v) return res.status(404).json({ error: 'Verification not found' })
  const u = find('users', (x) => x.id === v.user_id)
  if (u) update('users', u.id, { verification_status: 'verified', verified_at: new Date().toISOString(), trust_score: Math.min(100, (u.trust_score || 42) + 20) })
  // approved: keep status, DISCARD the selfie image (don't retain biometrics)
  update('verifications', v.id, { status: 'approved', selfie: null, reviewed_at: new Date().toISOString() })
  insert('modActions', { id: uuid(), kind: 'verify_approve', user_id: v.user_id, at: new Date().toISOString() })
  if (u) notify(u.id, { type: 'verification', title: '✅ You are verified!', body: 'Your identity check passed. Your profile now shows the Verified badge.', data: {} })
  res.json({ ok: true, status: 'approved' })
})
app.post('/v1/admin/verifications/:id/reject', requireAdmin, (req, res) => {
  const v = find('verifications', (x) => x.id === req.params.id)
  if (!v) return res.status(404).json({ error: 'Verification not found' })
  const u = find('users', (x) => x.id === v.user_id)
  if (u) update('users', u.id, { verification_status: 'rejected' })
  update('verifications', v.id, { status: 'rejected', selfie: null, reviewed_at: new Date().toISOString(), note: (req.body && req.body.note) || '' })
  insert('modActions', { id: uuid(), kind: 'verify_reject', user_id: v.user_id, at: new Date().toISOString() })
  if (u) notify(u.id, { type: 'verification', title: 'Verification needs another try', body: 'Your selfie could not be verified. Please re-submit a clear, well-lit photo of your face.', data: {} })
  res.json({ ok: true, status: 'rejected' })
})

// Remove (soft-delete) a flagged/abusive message
app.post('/v1/admin/messages/:id/remove', requireAdmin, (req, res) => {
  const m = find('messages', (x) => x.id === req.params.id)
  if (!m) return res.status(404).json({ error: 'Message not found' })
  update('messages', m.id, { removed: true, body: '[removed by moderator]', shield_flags: [] })
  insert('modActions', { id: uuid(), kind: 'remove_message', message_id: m.id, at: new Date().toISOString() })
  res.json({ ok: true, removed: true })
})

app.use((req, res) => res.status(404).json({ error: 'Not found', path: req.originalUrl }))
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'Server error' }) })

const PORT = process.env.PORT || 4000
async function start() {
  try { await initStore() } catch (e) { console.error('Postgres init failed, continuing in-memory:', e.message) }
  if (DB.users.length === 0) { seed(); console.log('Seeded sample members.') }
  else console.log('Loaded ' + DB.users.length + ' existing users; skipping seed.')
  loadConfig() // load persisted feature flags / runtime config (after store init)
  console.log('Config loaded — auth_mode=' + AUTH_MODE + (CONFIG.maintenance ? ', MAINTENANCE ON' : ''))
  // Backfill gender on existing sample profiles created before matrimony matching (idempotent).
  const SAMPLE_GENDER = { Aarohi: 'female', Neha: 'female', Vikram: 'male', Rohan: 'male' }
  for (const p of DB.profiles) {
    const g = SAMPLE_GENDER[p.display_name]
    if (g && normGender(p.gender) !== g) { p.gender = g; update('profiles', p.id, p) }
  }
  app.listen(PORT, () => console.log('No2Dowry API v1.1.0 on port ' + PORT + (pgReady ? ' (Postgres — persistent)' : ' (in-memory)')))
}
start()
