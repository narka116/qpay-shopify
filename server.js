/**
 * QPay v2 + Shopify integration backend
 * Дэлгүүр: drift-ub.myshopify.com
 *
 * Үндсэн flow:
 *  1. Customer Shopify дээр захиалга хийнэ → Manual Payment "QPay" сонгоно
 *  2. Shopify thank-you page → /pay.html руу redirect хийнэ
 *  3. /pay.html → POST /api/invoice/create → QPay-аас QR авна
 *  4. Customer мобайл банкаар төлнө
 *  5. QPay → /api/qpay/callback дуудна
 *  6. Backend → /v2/payment/check ажиллуулж баталгаажуулна
 *  7. Shopify Admin API → захиалгыг "Paid" болгоно
 */

const express = require('express');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const {
  QPAY_USERNAME,
  QPAY_PASSWORD,
  QPAY_INVOICE_CODE,
  QPAY_BASE_URL = 'https://merchant.qpay.mn',
  SHOPIFY_DOMAIN,
  SHOPIFY_ACCESS_TOKEN,
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_API_VERSION = '2024-10',
  PUBLIC_URL,
  SHARED_SECRET,
  PORT = 3000,
} = process.env;

let _token = null;
let _tokenExpiresAt = 0;

async function getQPayToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_token && now < _tokenExpiresAt - 60) return _token;

  const basic = Buffer
    .from(`${QPAY_USERNAME}:${QPAY_PASSWORD}`)
    .toString('base64');

  const { data } = await axios.post(
    `${QPAY_BASE_URL}/v2/auth/token`,
    {},
    { headers: { Authorization: `Basic ${basic}` }, timeout: 15000 }
  );

  _token = data.access_token;
  _tokenExpiresAt = data.expires_in || (now + 3600);
  console.log(`[qpay] new token, expires at ${new Date(_tokenExpiresAt * 1000).toISOString()}`);
  return _token;
}

async function qpay(method, url, body) {
  const token = await getQPayToken();
  try {
    const { data } = await axios({
      method,
      url: `${QPAY_BASE_URL}${url}`,
      data: body,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 20000,
    });
    return data;
  } catch (err) {
    if (err.response?.status === 401) {
      _token = null;
      _tokenExpiresAt = 0;
    }
    throw err;
  }
}

const invoiceStore = new Map();

function shopifyApi(method, url, body) {
  return axios({
    method,
    url: `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${url}`,
    data: body,
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    timeout: 20000,
  }).then(r => r.data);
}

async function markOrderPaid(orderId, amountMnt, qpayPaymentId) {
  return shopifyApi('POST', `/orders/${orderId}/transactions.json`, {
    transaction: {
      kind: 'capture',
      status: 'success',
      amount: String(amountMnt),
      currency: 'MNT',
      gateway: 'QPay',
      authorization: qpayPaymentId,
    },
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

const crypto = require('crypto');

app.get('/auth/shopify/install', (req, res) => {
  if (!SHOPIFY_API_KEY) return res.status(500).send('SHOPIFY_API_KEY байхгүй');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = `${PUBLIC_URL}/auth/shopify/callback`;
  const url = `https://${SHOPIFY_DOMAIN}/admin/oauth/authorize`
    + `?client_id=${SHOPIFY_API_KEY}`
    + `&scope=read_orders,write_orders`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&state=${state}`
    + `&grant_options[]=`;
  res.redirect(url);
});

app.get('/auth/shopify/callback', async (req, res) => {
  try {
    const { code, shop } = req.query;
    if (!code || !shop) return res.status(400).send('code эсвэл shop байхгүй');
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).send('SHOPIFY_API_KEY/SECRET тохируулаагүй');
    }
    const { data } = await axios.post(`https://${shop}/admin/oauth/access_token`, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    });
    const token = data.access_token;
    console.log(`[shopify] access_token авлаа: ${token}`);
    res.send(`<!doctype html><html><body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:24px"><h2>Shopify Admin API token бэлэн</h2><p>Доорх токеныг хуулж авч, Render dashboard / Environment хэсэгт <code>SHOPIFY_ACCESS_TOKEN</code> утгаар тохируулаад Save дарна:</p><pre style="background:#f4f4f5;padding:12px;border-radius:8px;word-break:break-all;user-select:all">${token}</pre><p>Render автоматаар restart хийнэ.</p></body></html>`);
  } catch (err) {
    console.error('OAuth callback error:', err.response?.data || err.message);
    res.status(500).send('Error: ' + (err.response?.data?.error_description || err.message));
  }
});

app.get('/api/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const data = await shopifyApi('GET', `/orders/${orderId}.json`);
    const o = data.order;
    res.json({
      id: o.id,
      name: o.name,
      total_price: o.total_price,
      currency: o.currency,
      financial_status: o.financial_status,
      customer_email: o.email,
    });
  } catch (err) {
    console.error('order fetch error:', err.response?.data || err.message);
    res.status(404).json({ error: 'Order not found' });
  }
});

app.post('/api/invoice/create', async (req, res) => {
  try {
    const { order_id, secret } = req.body;
    if (SHARED_SECRET && secret !== SHARED_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const orderData = await shopifyApi('GET', `/orders/${order_id}.json`);
    const order = orderData.order;
    if (order.financial_status === 'paid') {
      return res.status(409).json({ error: 'already paid' });
    }
    const amount = Math.round(parseFloat(order.total_price));
    const callbackUrl = `${PUBLIC_URL}/api/qpay/callback?order_id=${order_id}`;
    const invoice = await qpay('POST', '/v2/invoice', {
      invoice_code: QPAY_INVOICE_CODE,
      sender_invoice_no: String(order.name || order_id),
      invoice_receiver_code: 'terminal',
      invoice_description: `${order.name || 'Order'} drift-ub.myshopify.com`,
      amount,
      callback_url: callbackUrl,
    });
    invoiceStore.set(invoice.invoice_id, { order_id, amount, created_at: Date.now() });
    res.json({
      invoice_id: invoice.invoice_id,
      qr_text: invoice.qr_text,
      qr_image: invoice.qr_image,
      urls: invoice.urls,
      amount,
    });
  } catch (err) {
    console.error('invoice create error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/api/invoice/:invoiceId/status', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const result = await qpay('POST', '/v2/payment/check', {
      object_type: 'INVOICE',
      object_id: invoiceId,
      offset: { page_number: 1, page_limit: 100 },
    });
    const paidRow = (result.rows || []).find(r => r.payment_status === 'PAID');
    res.json({
      paid: !!paidRow,
      payment_id: paidRow?.payment_id,
      paid_amount: paidRow?.payment_amount,
    });
  } catch (err) {
    console.error('status check error:', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.all('/api/qpay/callback', async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const orderId = req.query.order_id || req.body?.order_id;
    if (!orderId) { console.warn('callback: order_id байхгүй'); return; }
    const entry = [...invoiceStore.entries()].find(([, v]) => v.order_id == orderId);
    if (!entry) { console.warn(`callback: invoice mapping байхгүй (order ${orderId})`); return; }
    const [invoiceId, info] = entry;
    const check = await qpay('POST', '/v2/payment/check', {
      object_type: 'INVOICE',
      object_id: invoiceId,
      offset: { page_number: 1, page_limit: 100 },
    });
    const paidRow = (check.rows || []).find(r => r.payment_status === 'PAID');
    if (!paidRow) { console.warn(`callback: order ${orderId} төлөгдсөн гэж шалгагдаагүй`); return; }
    if (Math.round(paidRow.payment_amount) < info.amount) {
      console.warn(`callback: order ${orderId} дутуу төлөгдсөн (${paidRow.payment_amount} < ${info.amount})`);
      return;
    }
    await markOrderPaid(orderId, paidRow.payment_amount, paidRow.payment_id);
    console.log(`[ok] order ${orderId} PAID (qpay payment ${paidRow.payment_id})`);
    invoiceStore.delete(invoiceId);
  } catch (err) {
    console.error('callback handler error:', err.response?.data || err.message);
  }
});

app.listen(PORT, () => {
  console.log(`QPay Shopify backend ${PORT} порт дээр асав`);
  console.log(`Public URL: ${PUBLIC_URL || '(togtoogu)'}`);
  console.log(`Shopify:    ${SHOPIFY_DOMAIN}`);
});
