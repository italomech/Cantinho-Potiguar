import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MercadoPagoConfig, Payment, Preference, } from 'mercadopago';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getWhatsAppConfig, sendOrderToWhatsApp } from './whatsapp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const prisma = new PrismaClient();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET;
const publicUrl = process.env.PUBLIC_URL || 'https://cantinho-potiguar.onrender.com';
const mercadoPagoMode = process.env.MERCADOPAGO_ENV === 'production' ? 'production' : 'test';
const mercadoPagoAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
const paymentPayerEmail = process.env.PAYMENT_PAYER_EMAIL?.trim();
const mercadoPagoWebhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
const mercadoPagoWebhookUrl = `${publicUrl}/api/webhooks/mercadopago`;
const hasMercadoPagoToken = Boolean(mercadoPagoAccessToken && !/COLOQUE|SEU_TOKEN|YOUR_TOKEN/i.test(mercadoPagoAccessToken));
const mercadoPago = hasMercadoPagoToken
  ? new MercadoPagoConfig({ accessToken: mercadoPagoAccessToken })
  : null;
const paymentApi = mercadoPago ? new Payment(mercadoPago) : null;
const preferenceApi = mercadoPago ? new Preference(mercadoPago) : null;
const mercadoPagoApiUrl = 'https://api.mercadopago.com';
const whatsappConfig = getWhatsAppConfig();

if (!jwtSecret) console.warn('JWT_SECRET nao configurado. A autenticacao administrativa nao pode iniciar com seguranca.');
console.log('MERCADOPAGO_ACCESS_TOKEN configurado:', hasMercadoPagoToken);
console.log('MERCADOPAGO_ENV:', mercadoPagoMode);
console.log('MERCADOPAGO_WEBHOOK_URL:', mercadoPagoWebhookUrl);
if (!whatsappConfig.accessToken || !whatsappConfig.phoneNumberId || !whatsappConfig.graphApiVersion || !whatsappConfig.templateName || !whatsappConfig.destination) {
  console.warn('WhatsApp Cloud API nao configurada. O pagamento continuara funcionando, mas pedidos aprovados nao serao enviados.');
}

app.use(cors({ origin: process.env.CORS_ORIGIN || publicUrl, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const customerSchema = z.object({
  customerName: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(8).max(30),
  deliveryMethod: z.enum(['DELIVERY', 'PICKUP']),
  address: z.string().trim().max(200).optional().default(''),
  addressNumber: z.string().trim().max(20).optional().default(''),
  complement: z.string().trim().max(100).optional().default(''),
  neighborhood: z.string().trim().max(100).optional().default(''),
  reference: z.string().trim().max(150).optional().default(''),
  paymentMethod: z.enum(['PIX', 'CARD']),
  items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(30) })).min(1).max(30)
});
const statusSchema = z.object({ status: z.enum(['RECEIVED', 'PAYMENT_PENDING', 'PAID', 'PREPARING', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED']) });
const productSchema = z.object({
  name: z.string().trim().min(2).max(100), description: z.string().trim().max(500), imageUrl: z.string().url(),
  priceCents: z.number().int().min(1).max(100000), active: z.boolean().optional().default(true)
});

function signToken(admin) {
  return jwt.sign({ sub: admin.id, email: admin.email }, jwtSecret, { expiresIn: '8h' });
}
function requireAdmin(req, res, next) {
  try {
    const token = req.cookies.admin_token;
    if (!token || !jwtSecret) return res.status(401).json({ error: 'Nao autenticado.' });
    req.admin = jwt.verify(token, jwtSecret);
    next();
  } catch { res.status(401).json({ error: 'Sessao expirada.' }); }
}
function money(cents) { return Number((cents / 100).toFixed(2)); }
function orderPayload(order) {
  return { ...order, subtotal: money(order.subtotalCents), deliveryFee: money(order.deliveryFeeCents), total: money(order.totalCents) };
}
function normalizeNeighborhood(value) {
  return String(value || '').trim().toLocaleLowerCase('pt-BR');
}
function calculateDeliveryFeeCents(neighborhood, deliveryMethod) {
  if (deliveryMethod === 'PICKUP') return 0;
  const normalizedNeighborhood = normalizeNeighborhood(neighborhood);
  return ['upanema', 'ipanema'].includes(normalizedNeighborhood) ? 500 : 200;
}
async function calculateOrder(input) {
  const products = await prisma.product.findMany({ where: { id: { in: input.items.map(item => item.productId) }, active: true } });
  const byId = new Map(products.map(product => [product.id, product]));
  if (products.length !== new Set(input.items.map(item => item.productId)).size) throw new Error('Um ou mais produtos nao estao disponiveis.');
  const items = input.items.map(item => {
    const product = byId.get(item.productId);
    return { productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity: item.quantity };
  });
  const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const deliveryFeeCents = calculateDeliveryFeeCents(input.neighborhood, input.deliveryMethod);
  return { items, subtotalCents, deliveryFeeCents, totalCents: subtotalCents + deliveryFeeCents };
}
function paymentStatusFromGateway(status) {
  const normalizedStatus = String(status || '').toLowerCase();
  if (normalizedStatus === 'approved') return { paymentStatus: 'APPROVED', orderStatus: 'PAID' };
  if (['rejected', 'cancelled', 'refunded', 'charged_back'].includes(normalizedStatus)) {
    return { paymentStatus: 'REJECTED', orderStatus: 'CANCELLED' };
  }
  return { paymentStatus: 'PENDING', orderStatus: 'PAYMENT_PENDING' };
}
function isStalePaymentStatus(order, nextStatus) {
  return order.paymentStatus !== 'PENDING' && nextStatus.paymentStatus === 'PENDING';
}
async function syncPayment(paymentId) {
  if (!paymentApi) throw new Error('Mercado Pago nao configurado.');
  const payment = await paymentApi.get({ id: paymentId });
  const conditions = [{ paymentId: String(payment.id) }];
  if (payment.external_reference) conditions.push({ id: String(payment.external_reference) });
  const order = await prisma.order.findFirst({ where: { OR: conditions } });
  if (!order) {
    console.warn('Mercado Pago: pagamento sem pedido local:', String(payment.id));
    return null;
  }
  const status = paymentStatusFromGateway(payment.status);
  if (isStalePaymentStatus(order, status)) {
    console.log('Mercado Pago: status antigo ignorado:', String(payment.id), 'pedido:', order.id, 'status atual:', order.paymentStatus);
    return order;
  }
  if (order.paymentId === String(payment.id) && order.paymentStatus === status.paymentStatus && order.orderStatus === status.orderStatus) {
    if (status.paymentStatus === 'APPROVED') await sendPaidOrderToWhatsApp(order.id);
    return order;
  }
  const updatedOrder = await prisma.order.update({ where: { id: order.id }, data: { paymentId: String(payment.id), ...status } });
  console.log('Mercado Pago: pagamento sincronizado:', String(payment.id), 'pedido:', order.id, 'status:', payment.status || 'unknown');
  if (status.paymentStatus === 'APPROVED') await sendPaidOrderToWhatsApp(updatedOrder.id);
  return updatedOrder;
}

function paymentFromOrderResponse(orderResponse) {
  return orderResponse.transactions?.payments?.[0]
    || orderResponse.transaction?.payments?.[0]
    || orderResponse.payments?.[0]
    || null;
}
function statusUpdateFromMercadoPago(orderResponse, payment) {
  const orderStatus = String(orderResponse.status || '').toLowerCase();
  const orderDetail = String(orderResponse.status_detail || '').toLowerCase();
  const paymentStatus = String(payment?.status || '').toLowerCase();
  const paymentDetail = String(payment?.status_detail || '').toLowerCase();
  const isApproved = (orderStatus === 'processed' && orderDetail === 'accredited')
    || ['approved', 'processed', 'completed'].includes(paymentStatus)
    || ['approved', 'accredited', 'processed', 'completed'].includes(paymentDetail);
  if (isApproved) return { paymentStatus: 'APPROVED', orderStatus: 'PAID' };
  if (['rejected', 'cancelled', 'refunded', 'charged_back', 'failed', 'expired'].includes(orderStatus)
    || ['rejected', 'cancelled', 'refunded', 'charged_back', 'failed', 'expired'].includes(paymentStatus)) {
    return { paymentStatus: 'REJECTED', orderStatus: 'CANCELLED' };
  }
  return { paymentStatus: 'PENDING', orderStatus: 'PAYMENT_PENDING' };
}
async function syncOrderFromMercadoPago(orderId) {
  if (!mercadoPagoAccessToken || !hasMercadoPagoToken) throw new Error('Mercado Pago nao configurado.');
  const response = await fetch(`${mercadoPagoApiUrl}/v1/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${mercadoPagoAccessToken}` }
  });
  if (!response.ok) {
  if (response.status === 400 || response.status === 404) {
    console.warn(
      `Mercado Pago: order ${String(orderId)} não encontrado na API (HTTP ${response.status}).`
    );
    return null;
  }

  throw new Error(`Mercado Pago Orders API respondeu ${response.status}.`);
}
  const mercadoPagoOrder = await response.json();
  const payment = paymentFromOrderResponse(mercadoPagoOrder);
  const localOrder = await prisma.order.findFirst({
    where: { OR: [{ id: String(mercadoPagoOrder.external_reference || '') }, { paymentId: String(orderId) }, { preferenceId: String(orderId) }] }
  });
  if (!localOrder) {
    console.warn('Mercado Pago: order sem pedido local:', String(orderId));
    return null;
  }
  const status = statusUpdateFromMercadoPago(mercadoPagoOrder, payment);
  if (isStalePaymentStatus(localOrder, status)) {
    console.log('Mercado Pago: status antigo ignorado:', String(orderId), 'pedido:', localOrder.id, 'status atual:', localOrder.paymentStatus);
    return localOrder;
  }
  if (localOrder.paymentId === String(payment?.id || orderId) && localOrder.paymentStatus === status.paymentStatus && localOrder.orderStatus === status.orderStatus) {
    if (status.paymentStatus === 'APPROVED') await sendPaidOrderToWhatsApp(localOrder.id);
    return localOrder;
  }
  const updatedOrder = await prisma.order.update({ where: { id: localOrder.id }, data: { paymentId: String(payment?.id || orderId), ...status } });
  console.log('Mercado Pago: order sincronizada:', String(orderId), 'pedido:', localOrder.id, 'status:', mercadoPagoOrder.status || 'unknown');
  if (status.paymentStatus === 'APPROVED') await sendPaidOrderToWhatsApp(updatedOrder.id);
  return updatedOrder;
}
function safeMercadoPagoError(error) {
  return { name: error?.name, message: error?.message, status: error?.status, code: error?.code, mercadoPagoStatus: error?.mercadoPagoStatus, mercadoPagoMessage: error?.mercadoPagoMessage };
}
async function sendPaidOrderToWhatsApp(orderId) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || order.paymentStatus !== 'APPROVED' || order.orderStatus !== 'PAID') return;
  const claim = await prisma.order.updateMany({
    where: { id: orderId, paymentStatus: 'APPROVED', orderStatus: 'PAID', whatsappSentAt: null, whatsappSendingAt: null },
    data: { whatsappSendingAt: new Date() }
  });
  if (!claim.count) return;
  try {
    const completeOrder = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    const result = await sendOrderToWhatsApp(completeOrder);
    await prisma.order.update({ where: { id: orderId }, data: { whatsappSendingAt: null, whatsappSentAt: new Date(), whatsappMessageId: result.messageId } });
    console.log('WhatsApp: pedido enviado:', orderId);
  } catch (error) {
    await prisma.order.updateMany({ where: { id: orderId, whatsappSendingAt: { not: null }, whatsappSentAt: null }, data: { whatsappSendingAt: null } });
    console.error('WhatsApp: erro ao enviar pedido:', error.status || 'unknown', error.message);
  }
}
async function createPixOrder(order) {
  if (!mercadoPagoAccessToken || !hasMercadoPagoToken) throw new Error('Mercado Pago nao configurado.');
  if (!paymentPayerEmail) throw new Error('PAYMENT_PAYER_EMAIL nao configurado.');
  if (mercadoPagoMode === 'test' && !/@testuser\.com$/i.test(paymentPayerEmail)) {
    throw new Error('No ambiente de teste, PAYMENT_PAYER_EMAIL deve ser de um usuario de teste do Mercado Pago.');
  }
  const response = await fetch(`${mercadoPagoApiUrl}/v1/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mercadoPagoAccessToken}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify({
      type: 'online',
      processing_mode: 'automatic',
      total_amount: money(order.totalCents).toFixed(2),
      external_reference: order.id,
      payer: { email: paymentPayerEmail },
      transactions: {
        payments: [{
          amount: money(order.totalCents).toFixed(2),
          payment_method: { id: 'pix', type: 'bank_transfer' }
        }]
      }
    })
  });
  const responseBody = await response.json().catch(() => ({}));

console.log(
  'Mercado Pago: Order criada pelo SITE:',
  responseBody.id,
  'external_reference:',
  responseBody.external_reference
);

  if (!response.ok) {
    const error = new Error('Mercado Pago recusou a criacao do pagamento.');
    error.status = response.status;
    error.code = responseBody.error || responseBody.cause?.[0]?.code;
    error.mercadoPagoStatus = response.status;
    error.mercadoPagoMessage = responseBody.message || responseBody.error || responseBody.cause?.[0]?.description || 'Resposta invalida da API.';
    throw error;
  }
  return responseBody;
}

async function createCheckoutPreference(order) {
  if (!preferenceApi) throw new Error('Mercado Pago nao configurado.');
  const items = order.items.map(item => ({
    id: item.productId,
    title: item.productName,
    quantity: item.quantity,
    unit_price: money(item.unitPriceCents),
    currency_id: 'BRL'
  }));
  if (order.deliveryFeeCents > 0) items.push({ id: `delivery-${order.id}`, title: 'Taxa de entrega', quantity: 1, unit_price: money(order.deliveryFeeCents), currency_id: 'BRL' });
  return preferenceApi.create({ body: {
    items,
    external_reference: order.id,
    back_urls: {
      success: `${publicUrl}/?payment=success&order=${order.id}`,
      pending: `${publicUrl}/?payment=pending&order=${order.id}`,
      failure: `${publicUrl}/?payment=failure&order=${order.id}`
    },
    auto_return: 'approved',
    notification_url: mercadoPagoWebhookUrl
  } });
}

app.get('/api/products', async (_req, res) => {
  const products = await prisma.product.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } });
  res.json(products.map(product => ({ ...product, price: money(product.priceCents) })));
});
app.get('/api/settings', async (_req, res) => {
  const setting = await prisma.setting.findUnique({ where: { id: 'main' } });
  res.json({ deliveryFee: money(setting?.deliveryFeeCents || 0) });
});

app.post('/api/orders', async (req, res) => {
  const parsed = customerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Confira os dados do pedido.', details: parsed.error.flatten() });
  try {
    const input = parsed.data;
    if (!input.items.length) return res.status(400).json({ error: 'Adicione ao menos um item ao pedido.' });
    if (input.deliveryMethod === 'DELIVERY' && (!input.address || !input.addressNumber || !input.neighborhood)) {
      return res.status(400).json({ error: 'Informe o endereco completo para entrega.' });
    }
    const calculated = await calculateOrder(input);
    const order = await prisma.order.create({ data: {
      customerName: input.customerName, phone: input.phone, deliveryMethod: input.deliveryMethod,
      address: input.address || null, addressNumber: input.addressNumber || null, complement: input.complement || null,
      neighborhood: input.neighborhood || null, reference: input.reference || null, paymentMethod: input.paymentMethod,
      subtotalCents: calculated.subtotalCents, deliveryFeeCents: calculated.deliveryFeeCents, totalCents: calculated.totalCents,
      items: { create: calculated.items }
    }, include: { items: true } });

    if (!mercadoPagoAccessToken || !hasMercadoPagoToken) return res.status(503).json({ error: 'Mercado Pago nao configurado no servidor.' });
    let payment;
    if (input.paymentMethod === 'PIX') {
      const mercadoPagoOrder = await createPixOrder(order);
      const payment = paymentFromOrderResponse(mercadoPagoOrder);
      const paymentMethod = payment?.payment_method || {};
      if (!mercadoPagoOrder.id || !payment?.id || !paymentMethod.qr_code || !paymentMethod.qr_code_base64) {
        const error = new Error('Mercado Pago nao retornou os dados Pix esperados.');
        error.status = 502;
        throw error;
      }
      const savedOrder = await prisma.order.update({ where: { id: order.id }, data: { paymentId: String(payment.id), preferenceId: String(mercadoPagoOrder.id), orderStatus: 'PAYMENT_PENDING' } });
      return res.status(201).json({ order: orderPayload(savedOrder), payment: { configured: true, type: 'PIX', status: payment.status || mercadoPagoOrder.status || 'action_required', order_id: String(mercadoPagoOrder.id), payment_id: String(payment.id), qr_code: paymentMethod.qr_code, qr_code_base64: paymentMethod.qr_code_base64, ticket_url: paymentMethod.ticket_url, amount: money(order.totalCents) } });
    }
    payment = await createCheckoutPreference(order);
    const savedOrder = await prisma.order.update({ where: { id: order.id }, data: { preferenceId: payment.id, orderStatus: 'PAYMENT_PENDING' }, include: { items: true } });
    const checkoutUrl = mercadoPagoMode === 'test' ? payment.sandbox_init_point : payment.init_point;
    return res.status(201).json({ order: orderPayload(savedOrder), payment: { configured: true, type: 'CARD', preferenceId: payment.id, checkoutUrl, mode: mercadoPagoMode } });
  } catch (error) {
    const safeError = safeMercadoPagoError(error);
    console.error('Mercado Pago HTTP status:', safeError.status || safeError.mercadoPagoStatus || 'unknown');
    console.error('Mercado Pago error:', safeError.mercadoPagoMessage || safeError.message);
    res.status(error.status === 400 || error.status === 401 || error.status === 422 ? 502 : 500).json({ error: 'Nao foi possivel iniciar o pagamento de teste. Confira as credenciais e os dados do comprador.' });
  }
});

app.post('/api/checkout/preferences', async (req, res) => {
  const parsed = z.object({ orderId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'orderId e obrigatorio.' });
  try {
    const order = await prisma.order.findUnique({ where: { id: parsed.data.orderId }, include: { items: true } });
    if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
    if (order.paymentMethod !== 'CARD') return res.status(400).json({ error: 'Este pedido nao usa cartao.' });
    if (order.orderStatus === 'CANCELLED' || order.paymentStatus === 'APPROVED') return res.status(409).json({ error: 'Este pedido nao pode iniciar um novo checkout.' });
    if (order.preferenceId) return res.json({ preferenceId: order.preferenceId });
    const preference = await createCheckoutPreference(order);
    await prisma.order.update({ where: { id: order.id }, data: { preferenceId: preference.id, orderStatus: 'PAYMENT_PENDING' } });
    res.status(201).json({ preferenceId: preference.id, checkoutUrl: mercadoPagoMode === 'test' ? preference.sandbox_init_point : preference.init_point, mode: mercadoPagoMode });
  } catch (error) {
    console.error('Checkout Pro:', error);
    res.status(502).json({ error: 'Nao foi possivel iniciar o Checkout Pro.' });
  }
});

app.get('/api/orders/:id/payment-status', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
    if (!order.preferenceId) return res.status(409).json({ error: 'Este pedido ainda nao possui uma Order do Mercado Pago.' });
    await syncOrderFromMercadoPago(order.preferenceId);
    const updatedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    res.json({ orderId: updatedOrder.id, paymentStatus: updatedOrder.paymentStatus, orderStatus: updatedOrder.orderStatus });
  } catch (error) {
    const safeError = safeMercadoPagoError(error);
    console.error('Mercado Pago HTTP status:', safeError.status || safeError.mercadoPagoStatus || 'unknown');
    console.error('Mercado Pago error:', safeError.mercadoPagoMessage || safeError.message);
    res.status(502).json({ error: 'Nao foi possivel consultar o status do pagamento.' });
  }
});

function hasValidMercadoPagoSignature(req, dataId) {
  if (!mercadoPagoWebhookSecret) return false;

  try {
  console.log(
  'MP WEBHOOK DEBUG:',
  'hasSignature=', Boolean(req.get('x-signature')),
  'hasRequestId=', Boolean(req.get('x-request-id')),
  'dataIdQuery=', String(req.query['data.id'] || '').trim().toLowerCase(),
  'dataIdBody=', String(req.body?.data?.id || '').trim().toLowerCase()
);

const xSignature = req.get('x-signature') || '';
const xRequestId = req.get('x-request-id') || '';
const dataIdForSignature = String(req.query['data.id'] || '').trim().toLowerCase();

const signatureParts = Object.fromEntries(
  xSignature.split(',').map((part) => {
    const [key, ...value] = part.trim().split('=');
    return [key, value.join('=')];
  })
);

const manifest = `id:${dataIdForSignature};request-id:${xRequestId};ts:${signatureParts.ts};`;

const expectedSignature = crypto
  .createHmac('sha256', mercadoPagoWebhookSecret)
  .update(manifest)
  .digest('hex');

console.log(
  'MP HMAC DEBUG:',
  'manualHmacValid=',
  expectedSignature === signatureParts.v1
);

    WebhookSignatureValidator.validate({
      xSignature: req.get('x-signature'),
      xRequestId: req.get('x-request-id'),
      dataId: String(dataId || req.query['data.id'] || '').trim().toLowerCase(),
      secret: mercadoPagoWebhookSecret,
    });

    console.log('MP WEBHOOK SIGNATURE VALID:', true);
    return true;
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) {
      console.log('MP WEBHOOK SIGNATURE VALID:', false);
      return false;
    }

    console.error(
      'MP WEBHOOK SIGNATURE ERROR:',
      error?.message || error
    );

    return false;
  }
}
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try {
    const eventType = String(req.body?.type || req.query.type || req.query.topic || '').toLowerCase();
    const action = String(req.body?.action || req.query.action || '').toLowerCase();
    const dataId = String(req.query['data.id'] || req.body?.data?.id || req.body?.id || '').toLowerCase();
    if (!dataId) return res.sendStatus(400);
    if (!mercadoPagoWebhookSecret) {
      console.error('Mercado Pago: MERCADOPAGO_WEBHOOK_SECRET nao configurado.');
      return res.sendStatus(503);
    }
    if (!hasValidMercadoPagoSignature(req, String(dataId))) return res.sendStatus(401);
    const isPaymentEvent = eventType === 'payment' || action.startsWith('payment.');
    const isOrderEvent = eventType === 'order' || action.startsWith('order.');
    if (isPaymentEvent) await syncPayment(String(dataId));
    else if (isOrderEvent) await syncOrderFromMercadoPago(String(dataId));
    else console.log('Mercado Pago: evento ignorado:', eventType || action || 'unknown');
    res.sendStatus(200);
  } catch (error) {
    const safeError = safeMercadoPagoError(error);
    console.error('Webhook Mercado Pago HTTP status:', safeError.status || safeError.mercadoPagoStatus || 'unknown');
    console.error('Webhook Mercado Pago erro:', safeError.mercadoPagoMessage || safeError.message || 'erro desconhecido');
    res.sendStatus(500);
  }
});

app.post('/api/admin/login', async (req, res) => {
  const parsed = z.object({ email: z.string().email(), password: z.string().min(8) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Credenciais invalidas.' });
  const admin = await prisma.admin.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
  if (!admin || !(await bcrypt.compare(parsed.data.password, admin.passwordHash))) return res.status(401).json({ error: 'Email ou senha incorretos.' });
  res.cookie('admin_token', signToken(admin), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 });
  res.json({ email: admin.email });
});
app.post('/api/admin/logout', requireAdmin, (_req, res) => { res.clearCookie('admin_token'); res.sendStatus(204); });
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ email: req.admin.email }));
app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  const orders = await prisma.order.findMany({ include: { items: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(orders.map(orderPayload));
});
app.patch('/api/admin/orders/:id/status', requireAdmin, async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Status invalido.' });
  const order = await prisma.order.update({ where: { id: req.params.id }, data: { orderStatus: parsed.data.status }, include: { items: true } });
  res.json(orderPayload(order));
});
app.get('/api/admin/products', requireAdmin, async (_req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'asc' } })));
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados do produto invalidos.' });
  res.status(201).json(await prisma.product.create({ data: parsed.data }));
});
app.patch('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const parsed = productSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Dados do produto invalidos.' });
  res.json(await prisma.product.update({ where: { id: req.params.id }, data: parsed.data }));
});
app.get('/api/admin/settings', requireAdmin, async (_req, res) => res.json(await prisma.setting.findUnique({ where: { id: 'main' } })));
app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const parsed = z.object({ deliveryFeeCents: z.number().int().min(0).max(100000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Taxa invalida.' });
  res.json(await prisma.setting.upsert({ where: { id: 'main' }, update: parsed.data, create: parsed.data }));
});

app.use(express.static(__dirname));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, '0.0.0.0', () => console.log(`Cantinho Potiguar em ${publicUrl}`));
