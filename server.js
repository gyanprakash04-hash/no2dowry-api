// No2Dowry.com — backend API (single-file deploy build).
// Storage: PostgreSQL when DATABASE_URL is set (data PERSISTS across restarts);
// otherwise an in-memory store (data resets on restart — fine for local/demo).
// Everything inlined: store, auth, shield, matchmaking, routes.
import express from 'express'
import cors from 'cors'
import crypto from 'crypto'
import pg from 'pg'

const SECRET = process.env.NO2DOWRY_SECRET || 'dev-secret-change-me'
const DATABASE_URL = process.env.DATABASE_URL || ''

/* ---------------- store (in-memory, optionally backed by Postgres) ---------------- */
const DB = { users: [], profiles: [], otps: [], connections: [], conversations: [], messages: [], videoDates: [], reports: [], subscriptions: [], familyInvites: [], bestieInvites: [] }
const uuid = () => crypto.randomUUID()
const find = (c, fn) => DB[c].find(fn)
const filter = (c, fn) => DB[c].filter(fn)
const insert = (c, row) => { DB[c].push(row); persist(c, row); return row }
const update = (c, id, patch) => { const r = DB[c].find((x) => x.id === id); if (r) { Object.assign(r, patch); persist(c, r) } return r }

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
  if (sig !== expected) return null
  try { return JSON.parse(Buffer.from(payload, 'base64url').toString()) } catch { return null }
}
function requireAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const claims = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : null)
  if (!claims) return res.status(401).json({ error: 'Unauthorized — please log in.' })
  if (!find('users', (u) => u.id === claims.uid)) return res.status(401).json({ error: 'Account not found — please log in again.' })
  req.userId = claims.uid
  next()
}

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

/* ---------------- app ---------------- */
const app = express()
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }))
app.use(express.json({ limit: '1mb' }))
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('X-Frame-Options', 'DENY'); next() })

const inConvo = (c, uid) => c && (c.user_a === uid || c.user_b === uid)

app.get('/v1/health', (req, res) => res.json({ ok: true, service: 'no2dowry-api', version: '1.2.0', storage: pgReady ? 'postgres' : 'memory', otp: OTP_LIVE ? 'msg91' : 'demo', time: new Date().toISOString() }))

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

app.post('/v1/auth/otp', async (req, res) => {
  const { phone } = req.body || {}
  if (!phone) return res.status(400).json({ error: 'phone required' })
  try {
    const r = await otpSend(phone)
    res.json({ ok: true, ...r })
  } catch (e) { res.status(502).json({ error: 'Could not send code: ' + e.message }) }
})
app.post('/v1/auth/verify', async (req, res) => {
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
app.post('/v1/account/delete', requireAuth, (req, res) => {
  const uid = req.userId
  const convoIds = filter('conversations', (c) => c.user_a === uid || c.user_b === uid).map((c) => c.id)
  const isMine = (row) => row.user_id === uid || row.id === uid || row.from_user === uid || row.to_user === uid ||
    row.requester === uid || row.recipient === uid || row.sender === uid || row.reporter === uid ||
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
  res.json({ ok: true, deleted: true })
})
app.post('/v1/slow-mode', requireAuth, (req, res) => {
  const u = find('users', (x) => x.id === req.userId)
  update('users', u.id, { slow_mode: !u.slow_mode })
  res.json({ ok: true, slow_mode: u.slow_mode })
})

app.get('/v1/profile', requireAuth, (req, res) => res.json({ ok: true, profile: find('profiles', (p) => p.user_id === req.userId) }))
app.put('/v1/profile', requireAuth, (req, res) => {
  const { display_name, age, city, occupation, interests, values_quiz, prompts } = req.body || {}
  if (!display_name) return res.status(400).json({ error: 'display_name required' })
  let p = find('profiles', (x) => x.user_id === req.userId)
  const data = { display_name, age, city, occupation, interests, values_quiz, prompts }
  if (p) Object.assign(p, data); else p = insert('profiles', { id: uuid(), user_id: req.userId, ...data })
  res.json({ ok: true, profile: p })
})
app.get('/v1/profile/:userId', requireAuth, (req, res) => {
  const prof = find('profiles', (p) => p.user_id === req.params.userId)
  if (!prof) return res.status(404).json({ error: 'Profile not found' })
  const u = find('users', (x) => x.id === req.params.userId) || {}
  res.json({ ok: true, profile: { user_id: prof.user_id, display_name: prof.display_name, age: prof.age, city: prof.city, occupation: prof.occupation, interests: prof.interests || [], prompts: prof.prompts || [], kundli: prof.kundli || null, trust_score: u.trust_score, verified: u.verification_status === 'verified', pledged: !!u.pledge_taken_at } })
})

app.get('/v1/matches/today', requireAuth, (req, res) => {
  const me = find('profiles', (p) => p.user_id === req.userId)
  if (!me) return res.status(400).json({ error: 'Build your profile first.' })
  const u = find('users', (x) => x.id === req.userId)
  const limit = u && u.slow_mode ? 2 : 4
  const others = filter('profiles', (p) => p.user_id !== req.userId)
  const matches = others.map((o) => ({ o, ...scorePair(me, o) })).sort((a, b) => b.compat - a.compat).slice(0, limit).map((c) => {
    const ou = find('users', (x) => x.id === c.o.user_id) || {}
    return { user_id: c.o.user_id, name: c.o.display_name, age: c.o.age, city: c.o.city, occupation: c.o.occupation, interests: c.o.interests, compatibility_score: c.compat, reasons: c.reasons, trust_score: ou.trust_score }
  })
  res.json({ ok: true, date: new Date().toISOString().slice(0, 10), matches })
})

app.post('/v1/connections', requireAuth, (req, res) => {
  const { to_user, opener_message } = req.body || {}
  if (!to_user) return res.status(400).json({ error: 'to_user required' })
  if (to_user === req.userId) return res.status(400).json({ error: "You can't connect with yourself." })
  const row = insert('connections', { id: uuid(), from_user: req.userId, to_user, opener_message: opener_message || '', status: 'pending', created_at: new Date().toISOString() })
  let conversation = null
  const rec = find('users', (u) => u.id === to_user)
  if (rec && rec.is_sample) {
    row.status = 'accepted'
    const pair = [req.userId, to_user].sort()
    conversation = insert('conversations', { id: uuid(), user_a: pair[0], user_b: pair[1], created_at: new Date().toISOString() })
    insert('messages', { id: uuid(), conversation_id: conversation.id, sender: to_user, body: 'Hi! So glad you reached out 😊 What made you say yes to the pledge?', shield_flags: [], shield_severity: 'none', created_at: new Date().toISOString() })
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
app.post('/v1/conversations/:id/messages', requireAuth, (req, res) => {
  const convo = find('conversations', (c) => c.id === req.params.id)
  if (!inConvo(convo, req.userId)) return res.status(403).json({ error: 'Not your conversation.' })
  const { body } = req.body || {}
  if (!body) return res.status(400).json({ error: 'body required' })
  const shield = detect(body)
  const msg = insert('messages', { id: uuid(), conversation_id: convo.id, sender: req.userId, body, shield_flags: shield.flags, shield_severity: shield.severity, created_at: new Date().toISOString() })
  const otherId = convo.user_a === req.userId ? convo.user_b : convo.user_a
  const other = find('users', (u) => u.id === otherId)
  if (other && other.is_sample && shield.severity !== 'high') {
    const replies = ['Haha I love that.', 'Totally agree 😄', 'Tell me more!', 'That is so me too.', 'Okay that won me over ☕']
    insert('messages', { id: uuid(), conversation_id: convo.id, sender: otherId, body: replies[Math.floor(Math.random() * replies.length)], shield_flags: [], shield_severity: 'none', created_at: new Date().toISOString() })
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

app.post('/v1/reports', requireAuth, (req, res) => {
  const { target_user, reason, message_id } = req.body || {}
  res.json({ ok: true, report: insert('reports', { id: uuid(), reporter: req.userId, target_user: target_user || null, message_id: message_id || null, reason: reason || 'unspecified', status: 'open', created_at: new Date().toISOString() }) })
})

app.get('/v1/admin/stats', (req, res) => res.json({ ok: true, users: DB.users.length, verified: filter('users', (u) => u.verification_status === 'verified').length, pledged: filter('users', (u) => u.pledge_taken_at).length, premium: filter('users', (u) => u.is_premium).length, connections: DB.connections.length, conversations: DB.conversations.length, videoDates: DB.videoDates.length, openReports: filter('reports', (r) => r.status === 'open').length }))
app.get('/v1/admin/flagged', (req, res) => res.json({ ok: true, flaggedMessages: filter('messages', (m) => (m.shield_flags || []).length).map((m) => ({ id: m.id, sender: m.sender, body: m.body, flags: m.shield_flags, severity: m.shield_severity })), openReports: filter('reports', (r) => r.status === 'open') }))

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
