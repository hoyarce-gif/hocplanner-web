/**
 * GET /api/webpay-confirm?token_ws=...
 * (Also accepts POST with token_ws in body — Webpay Plus sends GET by default.)
 *
 * Flow:
 *   1. Confirm (PUT) the transaction with Transbank.
 *   2. Retrieve pending booking from Netlify Blobs.
 *   3. If payment approved → create Google Calendar event → redirect to success page.
 *   4. If payment rejected → redirect to error page.
 *
 * Environment variables (same as book.js + availability.js):
 *   TRANSBANK_COMMERCE_CODE, TRANSBANK_API_KEY, TRANSBANK_ENV
 *   GOOGLE_SERVICE_ACCOUNT_JSON, CALENDAR_1_ID (target calendar for new events)
 *   URL  (Netlify auto-sets to site URL)
 */

const crypto = require('crypto')
const { getStore } = require('@netlify/blobs')

const TEST_COMMERCE_CODE = '597055555532'
const TEST_API_KEY = '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C'

function getTransbankConfig() {
  const isProd = process.env.TRANSBANK_ENV === 'production'
  return {
    commerceCode: process.env.TRANSBANK_COMMERCE_CODE || TEST_COMMERCE_CODE,
    apiKey: process.env.TRANSBANK_API_KEY || TEST_API_KEY,
    baseUrl: isProd
      ? 'https://webpay3g.transbank.cl'
      : 'https://webpay3gint.transbank.cl',
  }
}

// ── Google Calendar helpers ──────────────────────────────────────────────────

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

async function createCalendarEvent(token, calendarId, booking) {
  const { date, slot, name, email, topic } = booking
  const [h] = slot.split(':').map(Number)

  // Build RFC3339 start/end in America/Santiago timezone
  const startTime = `${date}T${slot}:00`
  const endTime   = `${date}T${String(h + 1).padStart(2, '0')}:00:00`

  const event = {
    summary: `Consultoría HOC — ${name}`,
    description: [
      `Cliente: ${name}`,
      `Email: ${email}`,
      topic ? `Tema: ${topic}` : '',
      `Pago: $${booking.amount?.toLocaleString('es-CL')} CLP`,
      `Orden: ${booking.buyOrder}`,
    ].filter(Boolean).join('\n'),
    start: { dateTime: startTime, timeZone: 'America/Santiago' },
    end:   { dateTime: endTime,   timeZone: 'America/Santiago' },
    attendees: [{ email }],
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }] },
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=all`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    }
  )
  const data = await res.json()
  if (!data.id) throw new Error('Calendar event creation failed: ' + JSON.stringify(data))
  return data.id
}

// ── handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const siteUrl = process.env.URL || 'https://hocplanner.cl'

  // Extract token_ws from query string (GET) or body (POST)
  let tokenWs = event.queryStringParameters?.token_ws
  if (!tokenWs && event.body) {
    try {
      const b = new URLSearchParams(event.body)
      tokenWs = b.get('token_ws')
    } catch { /* ignore */ }
  }

  // Webpay sends TBK_TOKEN in the body when the user cancels
  let tbkToken
  if (event.body) {
    try {
      const b = new URLSearchParams(event.body)
      tbkToken = b.get('TBK_TOKEN')
    } catch { /* ignore */ }
  }

  // User cancelled
  if (!tokenWs && tbkToken) {
    const redirectParams = new URLSearchParams({ status: 'cancelled' })
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/booking-confirmation.html?${redirectParams}` },
      body: '',
    }
  }

  if (!tokenWs) {
    const redirectParams = new URLSearchParams({ status: 'error', reason: 'token_missing' })
    return {
      statusCode: 302,
      headers: { Location: `${siteUrl}/booking-confirmation.html?${redirectParams}` },
      body: '',
    }
  }

  // ── 1. Confirm with Transbank ──
  const tbk = getTransbankConfig()
  let txResult
  try {
    const res = await fetch(
      `${tbk.baseUrl}/rswebpaytransaction/api/webpay/v1.2/transactions/${tokenWs}`,
      {
        method: 'PUT',
        headers: {
          'Tbk-Api-Key-Id': tbk.commerceCode,
          'Tbk-Api-Key-Secret': tbk.apiKey,
          'Content-Type': 'application/json',
        },
        body: '',
      }
    )
    txResult = await res.json()
  } catch (err) {
    console.error('[webpay-confirm] Transbank PUT error:', err.message)
    const p = new URLSearchParams({ status: 'error', reason: 'payment_gateway' })
    return { statusCode: 302, headers: { Location: `${siteUrl}/booking-confirmation.html?${p}` }, body: '' }
  }

  const approved = txResult.response_code === 0 && txResult.status === 'AUTHORIZED'

  // ── 2. Retrieve booking from Blobs ──
  let booking = null
  try {
    const store = getStore('bookings')
    const raw = await store.get(tokenWs)
    if (raw) {
      booking = JSON.parse(raw)
      // Clean up
      await store.delete(tokenWs).catch(() => {})
    }
  } catch (err) {
    console.warn('[webpay-confirm] Blobs retrieve error:', err.message)
  }

  if (!approved) {
    const p = new URLSearchParams({ status: 'error', reason: 'payment_rejected', code: String(txResult.response_code || '') })
    return { statusCode: 302, headers: { Location: `${siteUrl}/booking-confirmation.html?${p}` }, body: '' }
  }

  // ── 3. Create Google Calendar event ──
  if (booking) {
    const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    const calId = process.env.CALENDAR_1_ID
    if (SA_JSON && calId) {
      try {
        const gToken = await getGoogleToken(SA_JSON)
        const eventId = await createCalendarEvent(gToken, calId, booking)
        console.log('[webpay-confirm] Calendar event created:', eventId)
      } catch (err) {
        console.error('[webpay-confirm] Calendar event error:', err.message)
        // Non-fatal — payment was confirmed, don't fail the user
      }
    }
  }

  // ── 4. Redirect to success ──
  const successParams = new URLSearchParams({
    status: 'ok',
    date: booking?.date || '',
    slot: booking?.slot || '',
    name: booking?.name || '',
    amount: String(booking?.amount || ''),
    order: txResult.buy_order || booking?.buyOrder || '',
  })
  return {
    statusCode: 302,
    headers: { Location: `${siteUrl}/booking-confirmation.html?${successParams}` },
    body: '',
  }
}
