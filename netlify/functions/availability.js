/**
 * GET /api/availability?date=YYYY-MM-DD
 *
 * Returns available 1-hour consultation slots for the requested day.
 * Crosses:
 *   1. Working hours: Mon–Fri, 09–13 and 15–18 (America/Santiago)
 *   2. Google Calendar freebusy across up to 3 calendars (optional)
 *
 * Environment variables (set in Netlify UI):
 *   GOOGLE_SERVICE_ACCOUNT_JSON  – full JSON string of the service-account key
 *   CALENDAR_1_ID                – e.g. hocplanner@gmail.com
 *   CALENDAR_2_ID                – work calendar (read-only)
 *   CALENDAR_3_ID                – personal calendar
 */

const crypto = require('crypto')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Working-hour blocks (local Chile time)
const BLOCKS = [
  { start: 9, end: 13 },   // 09:00–13:00
  { start: 15, end: 18 },  // 15:00–18:00
]

// ── helpers ──────────────────────────────────────────────────────────────────

/** Return all working slots (local "HH:00") for a calendar date in Santiago. */
function getWorkingSlots(dateStr) {
  // Use Intl to determine day-of-week in America/Santiago
  const ref = new Date(dateStr + 'T12:00:00Z')
  const dow = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    weekday: 'short',
  }).format(ref)
  if (dow === 'Sat' || dow === 'Sun') return []

  const slots = []
  for (const b of BLOCKS) {
    for (let h = b.start; h < b.end; h++) {
      slots.push(String(h).padStart(2, '0') + ':00')
    }
  }
  return slots
}

/** Return the UTC-offset string for America/Santiago on a given date, e.g. "-04:00". */
function getSantiagoOffset(dateStr) {
  const ref = new Date(dateStr + 'T12:00:00Z')
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    timeZoneName: 'shortOffset',
  }).formatToParts(ref)
  const tzPart = parts.find(p => p.type === 'timeZoneName')
  if (!tzPart) return '-04:00'
  // tzPart.value looks like "GMT-4" or "GMT-3"
  const m = tzPart.value.match(/GMT([+-])(\d+)/)
  if (!m) return '-04:00'
  const sign = m[1]
  const hrs = String(m[2]).padStart(2, '0')
  return `${sign}${hrs}:00`
}

/** Build a Google OAuth2 access token from a service-account JSON string. */
async function getGoogleToken(saJson) {
  const sa = JSON.parse(saJson)
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url')

  const unsigned = `${header}.${claim}`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(unsigned)
  const sig = signer.sign(sa.private_key, 'base64url')
  const jwt = `${unsigned}.${sig}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  })
  const data = await res.json()
  if (!data.access_token) throw new Error('No access_token: ' + JSON.stringify(data))
  return data.access_token
}

/** Query Google Calendar freebusy and return [{start, end}] busy periods. */
async function getBusyPeriods(token, calendarIds, timeMin, timeMax) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: calendarIds.map(id => ({ id })),
    }),
  })
  const data = await res.json()
  const busy = []
  for (const cal of Object.values(data.calendars || {})) {
    for (const period of cal.busy || []) {
      busy.push({ start: new Date(period.start), end: new Date(period.end) })
    }
  }
  return busy
}

// ── handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }

  const { date } = event.queryStringParameters || {}
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Param ?date=YYYY-MM-DD requerido' }),
    }
  }

  const workingSlots = getWorkingSlots(date)
  if (workingSlots.length === 0) {
    return {
      statusCode: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, slots: [], reason: 'weekend' }),
    }
  }

  // Try to query Google Calendar
  // Calendar IDs: env vars override these defaults
  // Note: CALENDAR_1 and CALENDAR_2 point to hoyarce@hocplanner.cl (same account,
  //        same calendar — user should update CALENDAR_2_ID with the separate work calendar when available)
  const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  const calIds = [
    process.env.CALENDAR_1_ID || 'hoyarce@hocplanner.cl',
    process.env.CALENDAR_2_ID || 'hoyarce@hocplanner.cl',
    process.env.CALENDAR_3_ID || 'haoyarce@gmail.com',
  ].filter(Boolean)

  let busyPeriods = []
  if (SA_JSON && calIds.length > 0) {
    try {
      const token = await getGoogleToken(SA_JSON)
      const offset = getSantiagoOffset(date)
      const timeMin = `${date}T00:00:00${offset}`
      const timeMax = `${date}T23:59:59${offset}`
      busyPeriods = await getBusyPeriods(token, calIds, timeMin, timeMax)
    } catch (err) {
      console.error('[availability] Google Calendar error:', err.message)
      // Continue — return working slots without calendar filter
    }
  }

  // Remove slots that overlap any busy period
  const available = workingSlots.filter(slot => {
    const [h] = slot.split(':').map(Number)
    const offset = getSantiagoOffset(date)
    const slotStart = new Date(`${date}T${String(h).padStart(2,'0')}:00:00${offset}`)
    const slotEnd   = new Date(`${date}T${String(h + 1).padStart(2,'0')}:00:00${offset}`)
    return !busyPeriods.some(b => b.start < slotEnd && b.end > slotStart)
  })

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, slots: available }),
  }
}
