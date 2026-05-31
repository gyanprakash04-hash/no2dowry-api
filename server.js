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
const DB = { users: [], profiles: [], otps: [], connections: [], conversations: [], messages: [], videoDates: [], reports: [], subscriptions: [], familyInvites: [], bestieInvites: [], blocks: [], modActions: [], notifications: [], pushSubs: [], events: [], errors: [] }
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
    { name: 'Aarohi', age: 27, city: 'Pune', occupation: 'Product Designer', interests: ['Travel', 'Books', 'Yoga', 'Startups', 'Dogs'], vq: { lifeGoals: 'marriage_1_2y', familyOutlook: 'modern_close', lifestyle: 'active', communication: 'direct_kind', pace: 'open' }, prompts: [{ q: 'A perfect Sunday is…', a: 'Filter coffee, a long walk, and no alarm.' }, { q: 'I want a partner who…', a: 'laughs easily and disagrees respectfully.' }], kundli: 'High harmony (28/36 gunas) — optional view' },
    { name: 'Vikram', age: 30, city: 'Bengaluru', occupation: 'Software Engineer', interests: ['Trekking', 'Cooking', 'Cricket', 'Music'], vq: { lifeGoals: 'marriage_1_2y', familyOutlook: 'modern_close', lifestyle: 'outdoors', communication: 'direct_kind', pace: 'slow' }, prompts: [{ q: 'I geek out about…', a: 'trekking routes and badly-made chai.' }, { q: 'My ideal weekend', a: 'A hill, a tent, and no network bars.' }], kundli: 'Good match (24/36 gunas) — optional view' },
    { name: 'Neha', age: 26, city: 'Pune', occupation: 'Doctor', interests: ['Art', 'Medicine', 'Travel', 'Coffee'], vq: { lifeGoals: 'marriage_1_2y', familyOutlook: 'faith_modern', lifestyle: 'balanced', communication: 'thoughtful', pace: 'slow' }, prompts: [{ q: 'I unwind by…', a: 'painting and ignoring my group chats.' }, { q: 'Family means…', a: 'Sunday lunches that go on for hours.' }], kundli: 'Very high harmony (31/36) — optional view' },
    { name: 'Rohan', age: 31, city: 'Mumbai', occupation: 'Architect', interests: ['Design', 'Jazz', 'Coffee', 'Cycling'], vq: { lifeGoals: 'serious_no_rush', familyOutlook: 'modern_close', lifestyle: 'slow_living', communication: 'honest', pace: 'slow' }, prompts: [{ q: 'I could talk for hours about…', a: 'old buildings and new cities.' }, { q: 'I want a partner who…', a: 'is calm in chaos.' }], kundli: 'Balanced (22/36) — optional view' },
  ]
  for (const s of samples) {
    const id = uuid()
    insert('users', { id, phone: '+91-seed-' + s.name, created_at: new Date().toISOString(), pledge_taken_at: new Date().toISOString(), verification_status: 'verified', trust_score: 84, is_premium: false, status: 'active', slow_mode: false, is_sample: true })
    insert('profiles', { id: uuid(), user_id: id, display_name: s.name, age: s.age, city: s.city, occupation: s.occupation, interests: s.interests, values_quiz: s.vq, prompts: s.prompts, kundli: s.kundli })
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
  // Personality + about (≈12)
  personality: 3, interests: 4, hobbies: 2, about_me: 3,
  // Marriage preferences (≈10)
  pref_age_min: 2, pref_age_max: 2, pref_religion: 2, pref_location: 2, pref_education: 1, pref_occupation: 1,
  // Relationship expectations (≈8)
  looking_for: 3, ready_to_marry_in: 3, relocation: 2,
  // Anti-dowry commitment (≈5)
  dowry_free_commitment: 5,
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

app.get('/v1/health', (req, res) => res.json({ ok: true, service: 'no2dowry-api', version: '1.8.0-admin', storage: pgReady ? 'postgres' : 'memory', otp: OTP_LIVE ? 'live' : 'demo', push: PUSH_LIVE ? 'on' : 'off', adminLocked: !!ADMIN_TOKEN, time: new Date().toISOString() }))

// ---- OTP provider: MSG91 (WhatsApp primary + SMS fallback) with demo fallback ----
// Set these env vars to go live: MSG91_AUTHKEY and MSG91_OTP_TEMPLATE_ID.
// Channel order (WhatsApp then SMS) is configured on the MSG91 OTP template/settings.
// Until the keys are set, OTP runs in DEMO mode (fixed code 7291) so the app keeps working.
const MSG91_AUTHKEY = process.env.MSG91_AUTHKEY || ''
const MSG91_OTP_TEMPLATE_ID = process.env.MSG91_OTP_TEMPLATE_ID || ''
const OTP_LIVE = !!(MSG91_AUTHKEY && MSG91_OTP_TEMPLATE_ID)
const toMobile = (p) => { const d = String(p).replace(/\D/g, ''); return d.length === 10 ? '91' + d : d }

async function otpSend(phone) {
  if (!OTP_LIVE) {
    const ex = find('otps', (o) => o.phone === phone)
    if (ex) ex.code = '7291'; else insert('otps', { id: uuid(), phone, code: '7291' })
    return { sent: true, devCode: '7291', channel: 'demo' }
  }
  const url = 'https://control.msg91.com/api/v5/otp?template_id=' + encodeURIComponent(MSG91_OTP_TEMPLATE_ID) +
    '&mobile=' + toMobile(phone) + '&otp_expiry=10&realTimeResponse=1'
  const r = await fetch(url, { method: 'POST', headers: { authkey: MSG91_AUTHKEY, 'Content-Type': 'application/json' }, body: '{}' })
  const data = await r.json().catch(() => ({}))
  if (data.type === 'success' || r.ok) return { sent: true, channel: 'whatsapp+sms' }
  throw new Error(data.message || 'OTP send failed')
}
async function otpVerify(phone, code) {
  if (!OTP_LIVE) {
    const rec = find('otps', (o) => o.phone === phone)
    return !!(rec && rec.code === String(code))
  }
  const url = 'https://control.msg91.com/api/v5/otp/verify?otp=' + encodeURIComponent(code) + '&mobile=' + toMobile(phone)
  const r = await fetch(url, { headers: { authkey: MSG91_AUTHKEY } })
  const data = await r.json().catch(() => ({}))
  return data.type === 'success'
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
  if (!phone || !code) return res.status(400).json({ error: 'phone and code required' })
  let ok = false
  try { ok = await otpVerify(phone, code) } catch (e) { return res.status(502).json({ error: 'Verify failed: ' + e.message }) }
  if (!ok) return res.status(401).json({ error: 'Invalid code' })
  let user = find('users', (u) => u.phone === phone)
  if (!user) user = insert('users', { id: uuid(), phone, created_at: new Date().toISOString(), pledge_taken_at: null, verification_status: 'pending', trust_score: 42, is_premium: false, status: 'active', slow_mode: false })
  res.json({ ok: true, token: issueToken(user.id), user })
})

app.get('/v1/me', requireAuth, (req, res) => res.json({ ok: true, user: find('users', (u) => u.id === req.userId) }))
app.post('/v1/pledge', requireAuth, (req, res) => {
  const u = find('users', (x) => x.id === req.userId)
  if (u.pledge_taken_at) return res.json({ ok: true, user: u })
  update('users', u.id, { pledge_taken_at: new Date().toISOString(), trust_score: Math.min(100, u.trust_score + 12) })
  res.json({ ok: true, user: u })
})
app.post('/v1/verification/start', requireAuth, (req, res) => {
  const u = find('users', (x) => x.id === req.userId)
  update('users', u.id, { verification_status: 'verified', trust_score: Math.min(100, u.trust_score + 20) })
  res.json({ ok: true, user: u })
})
// DPDP right-to-erasure: delete the member's account and their data (memory + Postgres).
// Permanently remove a user and everything tied to them (profiles, connections,
// conversations+messages, blocks, reports, notifications, push subs, etc.).
function purgeUser(uid) {
  const convoIds = filter('conversations', (c) => c.user_a === uid || c.user_b === uid).map((c) => c.id)
  const isMine = (row) => row.user_id === uid || row.id === uid || row.from_user === uid || row.to_user === uid ||
    row.requester === uid || row.recipient === uid || row.sender === uid || row.reporter === uid ||
    row.blocker === uid || row.target === uid || row.target_user === uid ||
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
app.get('/v1/profile/:userId', requireAuth, (req, res) => {
  const prof = find('profiles', (p) => p.user_id === req.params.userId)
  if (!prof) return res.status(404).json({ error: 'Profile not found' })
  const u = find('users', (x) => x.id === req.params.userId) || {}
  // "Someone viewed your profile" — only for real members, not self, not blocked, throttled to 1/hour per viewer→owner
  const owner = req.params.userId
  if (owner !== req.userId && !u.is_sample && !blockedBetween(req.userId, owner)) {
    const key = req.userId + '|' + owner
    const now = Date.now()
    if (!lastView.has(key) || now - lastView.get(key) > 3600000) {
      lastView.set(key, now)
      notify(owner, { type: 'profile_view', title: '👀 Someone viewed your profile', body: 'A member just checked out your profile.', data: {} })
    }
  }
  res.json({ ok: true, profile: { user_id: prof.user_id, display_name: prof.display_name, age: prof.age, city: prof.city, occupation: prof.occupation, interests: prof.interests || [], prompts: prof.prompts || [], kundli: prof.kundli || null, trust_score: u.trust_score, verified: u.verification_status === 'verified', pledged: !!u.pledge_taken_at } })
})

app.get('/v1/matches/today', requireAuth, (req, res) => {
  const me = find('profiles', (p) => p.user_id === req.userId)
  if (!me) return res.status(400).json({ error: 'Build your profile first.' })
  const u = find('users', (x) => x.id === req.userId)
  const limit = u && u.slow_mode ? 2 : 4
  const others = filter('profiles', (p) => p.user_id !== req.userId && !blockedBetween(req.userId, p.user_id))
  // Visibility boost: profiles 80%+ complete are ranked higher (does not change the shown compat %).
  const boost = (o) => (computeCompleteness(o) >= 80 ? 1000 : 0)
  const matches = others.map((o) => ({ o, ...scorePair(me, o) })).sort((a, b) => (b.compat + boost(b.o)) - (a.compat + boost(a.o))).slice(0, limit).map((c) => {
    const ou = find('users', (x) => x.id === c.o.user_id) || {}
    return { user_id: c.o.user_id, name: c.o.display_name, age: c.o.age, city: c.o.city, occupation: c.o.occupation, interests: c.o.interests, compatibility_score: c.compat, reasons: c.reasons, trust_score: ou.trust_score }
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

app.get('/v1/admin/stats', requireAdmin, (req, res) => res.json({ ok: true, users: DB.users.length, verified: filter('users', (u) => u.verification_status === 'verified').length, pledged: filter('users', (u) => u.pledge_taken_at).length, premium: filter('users', (u) => u.is_premium).length, connections: DB.connections.length, conversations: DB.conversations.length, videoDates: DB.videoDates.length, openReports: filter('reports', (r) => r.status === 'open').length, events: DB.events.length, errors: DB.errors.length }))
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
      verified: u.verification_status === 'verified', pledged: !!u.pledge_taken_at, premium: !!u.is_premium,
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
  app.listen(PORT, () => console.log('No2Dowry API v1.1.0 on port ' + PORT + (pgReady ? ' (Postgres — persistent)' : ' (in-memory)')))
}
start()
