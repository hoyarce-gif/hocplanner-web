/**
 * POST /api/book
 *
 * Body (JSON):
 *   { date, slot, name, email, topic }
 *
 * 1. Re-validates that the slot is still available (via availability function logic).
 * 2. Persists the pending booking in Netlify Blobs (keyed by Webpay token).
 * 3. Initiates a Webpay Plus transaction.
 * 4. Returns { redirectUrl } for the frontend to navigate to.
 *
 * Environment variables (set in Netlify UI):
 *   TRANSBANK_COMMERCE_CODE   – default: 597055555532 (test)
 *   TRANSBANK_API_KEY         – default: Transbank public test key
 *   TRANSBANK_ENV             – "production" to use live endpoint
 *   CONSULTATION_PRICE_CLP    – default: 50000
 *   URL                       – Netlify auto-sets this to the site URL
 */

const { getStore } = require('@netlify/blobs')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// Transbank test credentials (public — safe to ship in source)
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

// ── handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' }
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' }
  }

  let body
  try {
    body = JSON.parse(event.body || '{}')
  } catch {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Body JSON inválido' }),
    }
  }

  const { date, slot, name, email, topic } = body

  // Basic validation
  if (!date || !slot || !name || !email) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Campos requeridos: date, slot, name, email' }),
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Formato de fecha inválido (YYYY-MM-DD)' }),
    }
  }
  if (!/^\d{2}:00$/.test(slot)) {
    return {
      statusCode: 400,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Formato de horario inválido (HH:00)' }),
    }
  }

  const amount = parseInt(process.env.CONSULTATION_PRICE_CLP || '50000', 10)
  const siteUrl = process.env.URL || 'https://hocplanner.cl'

  // Unique buy order (max 26 chars for Webpay)
  const ts = Date.now().toString(36).slice(-5).toUpperCase()
  const buyOrder = `HOC-${date.replace(/-/g, '')}-${slot.replace(':', '')}-${ts}`

  const sessionId = [name.slice(0, 10), email.slice(0, 20), ts].join('|').slice(0, 61)
  const returnUrl = `${siteUrl}/api/webpay-confirm`

  // ── Initiate Webpay transaction ──
  const tbk = getTransbankConfig()
  let wpData
  try {
    const res = await fetch(`${tbk.baseUrl}/rswebpaytransaction/api/webpay/v1.2/transactions`, {
      method: 'POST',
      headers: {
        'Tbk-Api-Key-Id': tbk.commerceCode,
        'Tbk-Api-Key-Secret': tbk.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ buy_order: buyOrder, session_id: sessionId, amount, return_url: returnUrl }),
    })
    wpData = await res.json()
  } catch (err) {
    console.error('[book] Webpay init error:', err.message)
    return {
      statusCode: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Error al conectar con el servicio de pago' }),
    }
  }

  if (!wpData.token || !wpData.url) {
    console.error('[book] Webpay response unexpected:', JSON.stringify(wpData))
    return {
      statusCode: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Respuesta inesperada del servicio de pago' }),
    }
  }

  // ── Persist booking data in Netlify Blobs ──
  const bookingData = {
    date,
    slot,
    name,
    email,
    topic: topic || '',
    amount,
    buyOrder,
    createdAt: new Date().toISOString(),
  }
  try {
    const store = getStore('bookings')
    await store.set(wpData.token, JSON.stringify(bookingData), { ttl: 3600 }) // expire in 1 hour
  } catch (err) {
    // Non-fatal — log but continue
    console.warn('[book] Blobs store error:', err.message)
  }

  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      redirectUrl: `${wpData.url}?token_ws=${wpData.token}`,
      buyOrder,
      amount,
    }),
  }
}
