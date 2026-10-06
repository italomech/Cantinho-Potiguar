import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import QRCode from 'qrcode';
import {
  MercadoPagoConfig,
  Payment,
  Preference,
  WebhookSignatureValidator,
  InvalidWebhookSignatureError
} from 'mercadopago';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = process.env.UPLOADS_DIR ? path.resolve(process.env.UPLOADS_DIR) : path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const app = express();
const prisma = new PrismaClient();
const port = Number(process.env.PORT || 3000);
const jwtSecret = process.env.JWT_SECRET;
const publicUrl = process.env.PUBLIC_URL || 'https://cantinho-potiguar.onrender.com';
const defaultPixKey = '13075085456';
const mercadoPagoMode = process.env.MERCADOPAGO_ENV === 'production' ? 'production' : 'test';
const mercadoPagoAccessToken = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
const mercadoPagoWebhookSecret = process.env.MERCADOPAGO_WEBHOOK_SECRET?.trim();
const mercadoPagoWebhookUrl = `${publicUrl}/api/webhooks/mercadopago`;
const hasMercadoPagoToken = Boolean(mercadoPagoAccessToken && !/COLOQUE|SEU_TOKEN|YOUR_TOKEN/i.test(mercadoPagoAccessToken));
const mercadoPago = hasMercadoPagoToken
  ? new MercadoPagoConfig({ accessToken: mercadoPagoAccessToken })
  : null;
const paymentApi = mercadoPago ? new Payment(mercadoPago) : null;
const preferenceApi = mercadoPago ? new Preference(mercadoPago) : null;
const mercadoPagoApiUrl = 'https://api.mercadopago.com';

if (!jwtSecret) console.warn('JWT_SECRET nao configurado. A autenticacao administrativa nao pode iniciar com seguranca.');
console.log('MERCADOPAGO_ACCESS_TOKEN configurado:', hasMercadoPagoToken);
console.log('MERCADOPAGO_ENV:', mercadoPagoMode);
console.log('MERCADOPAGO_WEBHOOK_URL:', mercadoPagoWebhookUrl);
app.use(cors({ origin: process.env.CORS_ORIGIN || publicUrl, credentials: true }));

app.use('/uploads', express.static(uploadDir));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const proofUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, file, callback) => {
      const safeName = `${Date.now()}-${crypto.randomUUID()}`;
      callback(null, safeName);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.pdf'];
    if (allowedMimes.includes(file.mimetype) || allowedExtensions.includes(path.extname(file.originalname || '').toLowerCase())) return callback(null, true);
    callback(new Error('Arquivo não aceito. Envie JPG, JPEG, PNG, WEBP ou PDF.'));
  }
});
const productImageUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, _file, callback) => callback(null, `product-${crypto.randomUUID()}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype) || (['.jpg', '.jpeg', '.png', '.webp'].includes(extension) && (!file.mimetype || file.mimetype === 'application/octet-stream'))) return callback(null, true);
    callback(new Error('Envie uma imagem JPG, PNG ou WEBP.'));
  }
});

const customerSchema = z.object({
  customerName: z.string().trim().min(2).max(100),
  phone: z.string().trim().min(8).max(30),
  deliveryMethod: z.enum(['DELIVERY', 'PICKUP']),
  address: z.string().trim().max(200).optional().default(''),
  addressNumber: z.string().trim().max(20).optional().default(''),
  complement: z.string().trim().max(100).optional().default(''),
  neighborhood: z.string().trim().max(100).optional().default(''),
  reference: z.string().trim().max(150).optional().default(''),
  paymentMethod: z.enum(['PIX', 'CARD', 'CASH']),
  items: z.array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(30) })).min(1).max(30)
});
const statusSchema = z.object({ status: z.enum(['RECEIVED', 'PAYMENT_PENDING', 'PAID', 'PREPARING', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED']) });
const cashOpeningDescription = 'Abertura do caixa';
const productSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500),
  imageUrl: z.preprocess(value => value === '' ? undefined : value, z.string().url().optional()),
  category: z.string().trim().min(1).max(60).default('Geral'),
  priceCents: z.preprocess(value => typeof value === 'string' && value !== '' ? Number(value) : value, z.number().int().min(1).max(100000)),
  costCents: z.preprocess(value => value === '' || value == null ? undefined : typeof value === 'string' ? Number(value) : value, z.number().int().min(0).max(100000).optional()),
  stock: z.preprocess(value => typeof value === 'string' && value !== '' ? Number(value) : value, z.number().int().min(0).max(100000)),
  manualSoldOut: z.preprocess(value => typeof value === 'string' ? value === 'true' : value, z.boolean().default(false)),
  active: z.preprocess(value => typeof value === 'string' ? value === 'true' : value, z.boolean().default(true))
});
const cashMovementSchema = z.object({
  type: z.enum(['ENTRY', 'OUTPUT']),
  amountCents: z.number().int().positive().max(100000000),
  description: z.string().trim().min(2).max(200).refine(description => description !== cashOpeningDescription, 'Descrição reservada para abertura do caixa.')
});
const cashClosureSchema = z.object({ cashCents: z.number().int().min(0).max(100000000) });

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
function centsFromMoney(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  if (typeof value === 'string') {
    const normalized = value.replace(/[R$\s.]/g, '').replace(',', '.');
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? Math.round(numeric * 100) : 0;
  }
  return 0;
}
function readPixTlvFields(value) {
  const fields = new Map();
  const bytes = Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const header = bytes.toString('ascii', offset, offset + 4);
    if (!/^\d{4}$/.test(header)) return null;
    const id = header.slice(0, 2);
    const length = Number(header.slice(2));
    offset += 4;
    if (offset + length > bytes.length) return null;
    fields.set(id, bytes.toString('utf8', offset, offset + length));
    offset += length;
  }
  return fields;
}
function pixCrc16(value) {
  let crc = 0xffff;
  for (const byte of value) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function hasValidPixCrc(payload) {
  const bytes = Buffer.from(payload, 'utf8');
  if (bytes.length < 8 || bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== '6304') return false;
  const checksum = bytes.toString('ascii', bytes.length - 4);
  return /^[\da-f]{4}$/i.test(checksum) && pixCrc16(bytes.subarray(0, bytes.length - 4)) === checksum.toUpperCase();
}
function pixKeyFromPayload(payload) {
  if (!hasValidPixCrc(payload)) return null;
  const fields = readPixTlvFields(payload);
  if (!fields) return null;
  for (const [id, value] of fields) {
    const tag = Number(id);
    if (tag < 26 || tag > 51) continue;
    const accountInfo = readPixTlvFields(value);
    if (accountInfo?.get('00') === 'BR.GOV.BCB.PIX') return accountInfo.get('01') || null;
  }
  return null;
}
function orderPayload(order) {
  return { ...order, subtotal: money(order.subtotalCents), deliveryFee: money(order.deliveryFeeCents), total: money(order.totalCents) };
}
class OrderValidationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const unavailableNeighborhoods = ['instabul', 'vertentes'];
function normalizeBlockedNeighborhood(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]/g, '');
}
function isOneEditAway(left, right) {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length === right.length && left[leftIndex + 1] === right[rightIndex] && left[leftIndex] === right[rightIndex + 1]) {
      leftIndex += 2;
      rightIndex += 2;
    } else if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }
  return edits + (leftIndex < left.length || rightIndex < right.length ? 1 : 0) <= 1;
}
function isUnavailableNeighborhood(value) {
  const normalized = normalizeBlockedNeighborhood(value);
  return unavailableNeighborhoods.some(neighborhood => isOneEditAway(normalized, neighborhood));
}
const unavailableNeighborhoodMessage = '🚫 No momento não realizamos entregas neste bairro. Por favor, escolha outro bairro ou selecione retirada no local.';
async function manualPixPayment() {
  const pixKey = process.env.PIX_KEY?.trim() || defaultPixKey;
  const pixPayload = process.env.PIX_QR_PAYLOAD?.trim();
  if (!pixKey) return { configured: false, qrConfigured: false };
  let qrCodeDataUrl = null;
  if (pixPayload && pixKeyFromPayload(pixPayload) === pixKey) {
    try {
      qrCodeDataUrl = await QRCode.toDataURL(pixPayload, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
    } catch {
      console.warn('PIX_QR_PAYLOAD não pôde ser convertido em QR Code.');
    }
  }
  return {
    configured: true,
    type: 'PIX',
    pixKey,
    qrConfigured: Boolean(qrCodeDataUrl),
    qrCodeDataUrl
  };
}
function normalizeNeighborhood(value) {
  return String(value || '').trim().toLocaleLowerCase('pt-BR');
}
function calculateDeliveryFeeCents(neighborhood, deliveryMethod) {
  if (deliveryMethod === 'PICKUP') return 0;
  const normalizedNeighborhood = normalizeNeighborhood(neighborhood);
  return ['upanema', 'ipanema'].includes(normalizedNeighborhood) ? 500 : 200;
}
async function calculateOrder(input, client = prisma) {
  const quantities = new Map();
  for (const item of input.items) quantities.set(item.productId, (quantities.get(item.productId) || 0) + item.quantity);
  if ([...quantities.values()].some(quantity => quantity > 30)) throw new OrderValidationError('INVALID_QUANTITY', 'A quantidade por produto não pode passar de 30.', 400);
  const products = await client.product.findMany({ where: { id: { in: [...quantities.keys()] }, active: true } });
  const byId = new Map(products.map(product => [product.id, product]));
  if (products.length !== quantities.size) throw new OrderValidationError('PRODUCT_UNAVAILABLE', 'Um ou mais produtos não estão disponíveis.');
  const items = [...quantities.entries()].map(([productId, quantity]) => {
    const product = byId.get(productId);
    if (product.manualSoldOut) throw new OrderValidationError('PRODUCT_UNAVAILABLE', `${product.name} está esgotado.`);
    if (product.stock < quantity) throw new OrderValidationError('INSUFFICIENT_STOCK', `Estoque insuficiente para ${product.name}. Disponível: ${product.stock}.`);
    return { productId: product.id, productName: product.name, unitPriceCents: product.priceCents, quantity };
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
function parseLocalDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2]) - 1 && date.getDate() === Number(match[3]) ? date : null;
}
function getDateWindow(period = 'today', customStart = null, customEnd = null) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay.getFullYear(), startOfDay.getMonth(), startOfDay.getDate() + 1);

  if (period === 'yesterday') {
    const yesterday = new Date(startOfDay);
    yesterday.setDate(yesterday.getDate() - 1);
    return { from: new Date(yesterday.getFullYear(), yesterday.getMonth(), yesterday.getDate()), to: new Date(startOfDay) };
  }
  if (period === 'last7') {
    const from = new Date(startOfDay);
    from.setDate(from.getDate() - 6);
    return { from, to: endOfDay };
  }
  if (period === 'month') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  }
  if (period === 'custom' && customStart && customEnd) {
    const from = parseLocalDate(customStart);
    const end = parseLocalDate(customEnd);
    if (!from || !end || from > end) throw new Error('Período personalizado inválido.');
    const to = new Date(end);
    to.setDate(to.getDate() + 1);
    return { from, to };
  }
  return { from: startOfDay, to: endOfDay };
}
async function getCashSummary(period = 'today', customStart = null, customEnd = null) {
  const window = getDateWindow(period, customStart, customEnd);
  const [allOrders, movementEntries, movementOutputs, lastClosure] = await Promise.all([
    prisma.order.findMany({ where: { createdAt: { gte: window.from, lt: window.to } }, include: { items: true } }),
    prisma.cashMovement.findMany({ where: { createdAt: { gte: window.from, lt: window.to }, type: 'ENTRY' } }),
    prisma.cashMovement.findMany({ where: { createdAt: { gte: window.from, lt: window.to }, type: 'OUTPUT' } }),
    prisma.cashClosure.findFirst({ where: { closedAt: { lt: window.from } }, orderBy: { closedAt: 'desc' } })
  ]);

  const validOrdersById = new Map(allOrders
    .filter(order => order.paymentStatus === 'APPROVED' && order.orderStatus !== 'CANCELLED')
    .map(order => [order.id, order]));
  const approvedOrders = [...validOrdersById.values()];
  const openingMovementEntries = movementEntries
    .filter(entry => entry.description === cashOpeningDescription)
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
  const operationalEntries = movementEntries.filter(entry => entry.description !== cashOpeningDescription);
  const operationalOutputs = movementOutputs.filter(entry => entry.description !== cashOpeningDescription);

  const productCosts = await prisma.product.findMany({
    where: { id: { in: [...new Set(approvedOrders.flatMap(order => order.items.map(item => item.productId)))] } }
  });

  const totalSold = approvedOrders.reduce((sum, order) => sum + order.totalCents, 0);
  const totalReceived = totalSold;
  const cashSales = approvedOrders.filter(order => order.paymentMethod === 'CASH').reduce((sum, order) => sum + order.totalCents, 0);
  const pix = approvedOrders.filter(order => order.paymentMethod === 'PIX').reduce((sum, order) => sum + order.totalCents, 0);
  const card = approvedOrders.filter(order => order.paymentMethod === 'CARD').reduce((sum, order) => sum + order.totalCents, 0);
  const manualEntries = operationalEntries.reduce((sum, entry) => sum + entry.amountCents, 0);
  const manualOutputs = operationalOutputs.reduce((sum, entry) => sum + entry.amountCents, 0);
  const feesByOrder = new Map(approvedOrders.map(order => [
    order.id,
    order.paymentMethod === 'CASH' ? 0 : Number(order.feeCents) > 0 ? Number(order.feeCents) : null
  ]));
  const fees = approvedOrders.reduce((sum, order) => sum + (feesByOrder.get(order.id) || 0), 0);
  const feesUnavailableOrdersCount = approvedOrders.filter(order => feesByOrder.get(order.id) === null).length;
  const costById = new Map(productCosts.map(product => [product.id, product.costCents == null ? null : Number(product.costCents)]));
  let costOfGoodsSold = 0;
  let costUnavailableItemsCount = 0;
  const sales = approvedOrders.map(order => {
    let orderCostCents = 0;
    let orderCostComplete = true;
    for (const item of order.items) {
      const unitCost = costById.get(item.productId);
      if (unitCost == null) {
        orderCostComplete = false;
        costUnavailableItemsCount += Number(item.quantity);
      } else {
        orderCostCents += unitCost * Number(item.quantity);
      }
    }
    costOfGoodsSold += orderCostCents;
    const feeCents = feesByOrder.get(order.id);
    return {
      date: order.createdAt,
      kind: 'sale',
      pedido: order.id,
      cliente: order.customerName,
      formaPagamento: order.paymentMethod,
      valor: order.totalCents,
      taxa: feeCents,
      taxaDisponivel: feeCents !== null,
      custo: orderCostComplete ? orderCostCents : null,
      custoDisponivel: orderCostComplete,
      lucro: order.totalCents - orderCostCents - (feeCents || 0),
      lucroParcial: !orderCostComplete || feeCents === null,
      status: order.paymentStatus
    };
  });
  const profitCents = totalSold - costOfGoodsSold - fees;
  const profitIsPartial = costUnavailableItemsCount > 0 || feesUnavailableOrdersCount > 0;
  const openingBalanceCents = openingMovementEntries.length
    ? openingMovementEntries[0].amountCents
    : lastClosure?.closingBalanceCents || 0;
  const expectedCashCents = openingBalanceCents + cashSales + manualEntries - manualOutputs;
  const movements = [...openingMovementEntries, ...operationalEntries, ...operationalOutputs]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));

  return {
    period,
    from: window.from,
    to: window.to,
    ordersCount: allOrders.length,
    approvedOrdersCount: approvedOrders.length,
    pendingOrdersCount: allOrders.filter(order => order.paymentStatus === 'PENDING' || order.orderStatus === 'PAYMENT_PENDING').length,
    cancelledOrdersCount: allOrders.filter(order => order.paymentStatus === 'REJECTED' || order.paymentStatus === 'CANCELLED' || order.orderStatus === 'CANCELLED').length,
    openingBalanceCents,
    totalSoldCents: totalSold,
    totalReceivedCents: totalReceived,
    cashSalesCents: cashSales,
    cashCents: cashSales,
    pixCents: pix,
    cardCents: card,
    feesCents: fees,
    feesUnavailableOrdersCount,
    manualEntriesCents: manualEntries,
    manualOutputsCents: manualOutputs,
    expensesCents: manualOutputs,
    expectedCashCents,
    closingBalanceCents: expectedCashCents,
    profitCents,
    profitIsPartial,
    costOfGoodsCents: costOfGoodsSold,
    costUnavailableItemsCount,
    orders: approvedOrders,
    sales,
    movements: movements.map(item => ({ ...item, type: item.description === cashOpeningDescription ? 'OPENING' : item.type }))
  };
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
    return order;
  }
  const updatedOrder = await prisma.order.update({ where: { id: order.id }, data: { paymentId: String(payment.id), ...status } });
  console.log('Mercado Pago: pagamento sincronizado:', String(payment.id), 'pedido:', order.id, 'status:', payment.status || 'unknown');
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
    return localOrder;
  }
  const updatedOrder = await prisma.order.update({ where: { id: localOrder.id }, data: { paymentId: String(payment?.id || orderId), ...status } });
  console.log('Mercado Pago: order sincronizada:', String(orderId), 'pedido:', localOrder.id, 'status:', mercadoPagoOrder.status || 'unknown');
  return updatedOrder;
}
function safeMercadoPagoError(error) {
  return { name: error?.name, message: error?.message, status: error?.status, code: error?.code, mercadoPagoStatus: error?.mercadoPagoStatus, mercadoPagoMessage: error?.mercadoPagoMessage };
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
  const pix = await manualPixPayment();
  res.json({ deliveryFee: money(setting?.deliveryFeeCents || 0), pix });
});

function handleProofUpload(req, res, next) {
  proofUpload.single('proof')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'O comprovante deve ter no máximo 10 MB.' });
    console.error('Upload do comprovante:', error);
    return res.status(400).json({ error: 'Arquivo não aceito. Envie JPG, JPEG, PNG, WEBP ou PDF.' });
  });
}

function handleProductImageUpload(req, res, next) {
  productImageUpload.single('image')(req, res, error => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'A foto deve ter no máximo 5 MB.' });
    console.error('Upload da foto do produto:', error);
    return res.status(400).json({ error: 'Envie uma imagem JPG, PNG ou WEBP de até 5 MB.' });
  });
}

function identifyProductImageType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return '.jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

async function persistProductImage(file) {
  const extension = identifyProductImageType(await fs.promises.readFile(file.path));
  if (!extension) throw new OrderValidationError('INVALID_PRODUCT_IMAGE', 'O arquivo não é uma imagem JPG, PNG ou WEBP válida.', 400);
  const filename = `${file.filename}${extension}`;
  const savedPath = path.join(uploadDir, filename);
  await fs.promises.rename(file.path, savedPath);
  file.path = savedPath;
  return `/uploads/${filename}`;
}

function managedProductImagePath(imageUrl) {
  const filename = path.basename(String(imageUrl || ''));
  return /^product-[\da-f-]{36}\.(jpg|png|webp)$/i.test(filename) ? path.join(uploadDir, filename) : null;
}

async function removeUnusedProductImage(imageUrl) {
  const oldPath = managedProductImagePath(imageUrl);
  if (!oldPath) return;
  const stillUsed = await prisma.product.findFirst({ where: { imageUrl } });
  if (stillUsed) return;
  try {
    await fs.promises.unlink(oldPath);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Não foi possível remover uma foto antiga do produto:', error);
  }
}

function identifyProofType(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', extension: '.jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', extension: '.png' };
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', extension: '.webp' };
  if (buffer.toString('ascii', 0, 5) === '%PDF-') return { mime: 'application/pdf', extension: '.pdf' };
  return null;
}

app.post('/api/orders/:id/proof', handleProofUpload, async (req, res) => {
  let proofPath = req.file?.path;
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) {
      if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
      return res.status(404).json({ error: 'Pedido nao encontrado.' });
    }
    if (order.paymentMethod !== 'PIX') {
      if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
      return res.status(400).json({ error: 'O comprovante só pode ser anexado a pedidos Pix.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Selecione um comprovante válido.' });
    const proofType = identifyProofType(await fs.promises.readFile(proofPath));
    if (!proofType) {
      await fs.promises.unlink(proofPath).catch(() => {});
      return res.status(400).json({ error: 'Arquivo inválido. Envie JPG, JPEG, PNG, WEBP ou PDF.' });
    }
    const safeFilename = `${req.file.filename}${proofType.extension}`;
    const safeProofPath = path.join(uploadDir, safeFilename);
    await fs.promises.rename(proofPath, safeProofPath);
    proofPath = safeProofPath;
    const proofUrl = `/uploads/${safeFilename}`;
    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        pixProofUrl: proofUrl,
        pixProofMime: proofType.mime,
        pixProofStatus: 'SENT',
        pixProofUploadedAt: new Date()
      }
    });
    res.json({ orderId: updatedOrder.id, proofUrl, proofStatus: 'SENT' });
  } catch (error) {
    if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
    console.error('Upload do comprovante:', error);
    res.status(500).json({ error: 'Não foi possível salvar o comprovante.' });
  }
});

app.post('/api/orders', handleProofUpload, async (req, res) => {
  let proofPath = req.file?.path;
  const body = { ...req.body };
  if (typeof body.items === 'string') {
    try { body.items = JSON.parse(body.items); }
    catch { body.items = null; }
  }
  const parsed = customerSchema.safeParse(body);
  if (!parsed.success) {
    if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
    return res.status(400).json({ error: 'Confira os dados do pedido.', details: parsed.error.flatten() });
  }
  try {
    const input = parsed.data;
    if (!input.items.length) {
      if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
      return res.status(400).json({ error: 'Adicione ao menos um item ao pedido.' });
    }
    if (input.deliveryMethod === 'DELIVERY' && (!input.address || !input.addressNumber || !input.neighborhood)) {
      if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
      proofPath = null;
      return res.status(400).json({ error: 'Informe o endereco completo para entrega.' });
    }
    if (input.deliveryMethod === 'DELIVERY' && isUnavailableNeighborhood(input.neighborhood)) {
      if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
      proofPath = null;
      return res.status(400).json({ error: unavailableNeighborhoodMessage });
    }
    let pixPayment = null;
    let proofType = null;
    if (input.paymentMethod === 'PIX') {
      if (!req.file) return res.status(400).json({ error: 'Selecione o comprovante Pix antes de enviar o pedido.' });
      proofType = identifyProofType(await fs.promises.readFile(proofPath));
      if (!proofType) {
        await fs.promises.unlink(proofPath).catch(() => {});
        proofPath = null;
        return res.status(400).json({ error: 'Arquivo inválido. Envie JPG, JPEG, PNG, WEBP ou PDF.' });
      }
      pixPayment = await manualPixPayment();
      if (!pixPayment.configured) {
        if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
        proofPath = null;
        return res.status(503).json({ error: 'Pagamento Pix ainda não configurado. Informe PIX_KEY e PIX_QR_PAYLOAD no ambiente do servidor.' });
      }
    } else if (req.file) {
      await fs.promises.unlink(proofPath).catch(() => {});
      proofPath = null;
      return res.status(400).json({ error: 'O comprovante só pode ser enviado com pagamento Pix.' });
    }
    let pixProofUrl = null;
    if (proofType) {
      const safeFilename = `${req.file.filename}${proofType.extension}`;
      const safeProofPath = path.join(uploadDir, safeFilename);
      await fs.promises.rename(proofPath, safeProofPath);
      proofPath = safeProofPath;
      pixProofUrl = `/uploads/${safeFilename}`;
    }
    const order = await prisma.$transaction(async transaction => {
      const calculated = await calculateOrder(input, transaction);
      for (const item of calculated.items) {
        const updated = await transaction.product.updateMany({
          where: { id: item.productId, active: true, manualSoldOut: false, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } }
        });
        if (updated.count !== 1) throw new OrderValidationError('INSUFFICIENT_STOCK', `Estoque insuficiente para ${item.productName}. Atualize o cardápio e tente novamente.`);
      }
      return transaction.order.create({ data: {
        customerName: input.customerName, phone: input.phone, deliveryMethod: input.deliveryMethod,
        address: input.address || null, addressNumber: input.addressNumber || null, complement: input.complement || null,
        neighborhood: input.neighborhood || null, reference: input.reference || null, paymentMethod: input.paymentMethod,
        subtotalCents: calculated.subtotalCents, deliveryFeeCents: calculated.deliveryFeeCents, totalCents: calculated.totalCents,
        ...(input.paymentMethod === 'PIX' ? { orderStatus: 'PAYMENT_PENDING' } : {}),
        ...(proofType ? { pixProofUrl, pixProofMime: proofType.mime, pixProofStatus: 'SENT', pixProofUploadedAt: new Date() } : {}),
        items: { create: calculated.items }
      }, include: { items: true } });
    });
    proofPath = null;

    if (input.paymentMethod === 'PIX') {
      return res.status(201).json({ order: orderPayload(order), payment: { ...pixPayment, status: 'PENDING' } });
    }

    if (input.paymentMethod === 'CASH') {
      return res.status(201).json({ order: orderPayload(order), payment: { configured: true, type: 'CASH' } });
    }

    if (!mercadoPagoAccessToken || !hasMercadoPagoToken) return res.status(503).json({ error: 'Mercado Pago nao configurado no servidor.' });
    const payment = await createCheckoutPreference(order);
    const savedOrder = await prisma.order.update({ where: { id: order.id }, data: { preferenceId: payment.id, orderStatus: 'PAYMENT_PENDING' }, include: { items: true } });
    const checkoutUrl = mercadoPagoMode === 'test' ? payment.sandbox_init_point : payment.init_point;
    return res.status(201).json({ order: orderPayload(savedOrder), payment: { configured: true, type: 'CARD', preferenceId: payment.id, checkoutUrl, mode: mercadoPagoMode } });
  } catch (error) {
    if (proofPath) await fs.promises.unlink(proofPath).catch(() => {});
    if (error instanceof OrderValidationError) return res.status(error.status).json({ error: error.message });
    if (parsed.data.paymentMethod === 'PIX') {
      const requestId = crypto.randomUUID();
      console.error('Falha no registro Pix', {
        requestId,
        endpoint: req.originalUrl,
        method: req.method,
        status: 500,
        contentType: req.get('content-type'),
        itemCount: parsed.data.items.length,
        proof: req.file ? { size: req.file.size, mimeType: req.file.mimetype } : null,
        error: { name: error.name, code: error.code, message: error.message, stack: error.stack }
      });
      return res.status(500).json({ error: 'Não foi possível registrar o pedido. Confira os dados e tente novamente.', requestId });
    }
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

  const xSignature = req.get('x-signature') || '';
  const xRequestId = req.get('x-request-id') || '';
  const rawDataId = String(dataId || req.query['data.id'] || '');
const normalizedDataId = rawDataId.toLowerCase();

  const signatureParts = {};

  for (const part of xSignature.split(',')) {
    const [key, ...rest] = part.split('=');

    if (key && rest.length) {
      signatureParts[key.trim()] = rest.join('=').trim();
    }
  }

  const ts = signatureParts.ts || '';
  const v1 = signatureParts.v1 || '';

  const manifest = `id:${normalizedDataId};request-id:${xRequestId};ts:${ts};`;

  const expectedSignature = crypto
    .createHmac('sha256', mercadoPagoWebhookSecret)
    .update(manifest)
    .digest('hex');

  console.log('========== MP WEBHOOK DEBUG ==========');
  console.log({
    hasXSignature: Boolean(xSignature),
    hasXRequestId: Boolean(xRequestId),
    rawDataId,
    dataId,
    requestId: xRequestId,
    ts,
    v1Length: v1.length,
    receivedPrefix: v1.slice(0, 8),
    expectedPrefix: expectedSignature.slice(0, 8),
    signaturesMatch: v1 === expectedSignature
  });
  console.log('======================================');

  try {
    WebhookSignatureValidator.validate({
      xSignature,
      xRequestId,
      dataId: normalizedDataId,
      secret: mercadoPagoWebhookSecret
    });

    console.log('MP WEBHOOK SIGNATURE VALID: true');
    return true;
  } catch (error) {
    if (error instanceof InvalidWebhookSignatureError) {
      console.error('MP WEBHOOK SIGNATURE INVALID:', error.message);
      return false;
    }

    console.error('MP WEBHOOK SIGNATURE ERROR:', error);
    return false;
  }
}
app.post('/api/webhooks/mercadopago', async (req, res) => {
  try {
    const eventType = String(req.body?.type || req.query.type || req.query.topic || '').toLowerCase();
    const action = String(req.body?.action || req.query.action || '').toLowerCase();
    const dataId = String(req.query['data.id'] || req.body?.data?.id || req.body?.id || '').trim();
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
  const existingOrder = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!existingOrder) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  const data = { orderStatus: parsed.data.status };
  if (existingOrder.paymentMethod === 'CASH' && parsed.data.status === 'PAID') data.paymentStatus = 'APPROVED';
  if (existingOrder.paymentMethod === 'CASH' && parsed.data.status === 'CANCELLED') data.paymentStatus = 'CANCELLED';
  const order = await prisma.order.update({ where: { id: req.params.id }, data, include: { items: true } });
  res.json(orderPayload(order));
});
app.patch('/api/admin/orders/:id/proof-status', requireAdmin, async (req, res) => {
  const parsed = z.object({ status: z.enum(['CONFIRMED', 'REJECTED']) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Status do comprovante invalido.' });
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  const nextStatus = parsed.data.status === 'CONFIRMED' ? { paymentStatus: 'APPROVED', orderStatus: 'PAID', pixProofStatus: 'CONFIRMED', pixProofConfirmedAt: new Date(), pixProofConfirmedBy: req.admin?.email || 'admin' } : { paymentStatus: 'REJECTED', orderStatus: 'CANCELLED', pixProofStatus: 'REJECTED', pixProofConfirmedAt: new Date(), pixProofConfirmedBy: req.admin?.email || 'admin' };
  const updated = await prisma.order.update({ where: { id: order.id }, data: nextStatus, include: { items: true } });
  res.json(orderPayload(updated));
});
app.get('/api/admin/products', requireAdmin, async (_req, res) => res.json(await prisma.product.findMany({ orderBy: { createdAt: 'asc' } })));
async function saveAdminProduct(req, res, create) {
  let imageUrl = null;
  let uncommittedImageUrl = null;
  const temporaryUploadPath = req.file?.path;
  try {
    const existing = create ? null : await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!create && !existing) return res.status(404).json({ error: 'Produto não encontrado.' });
    const parsed = (create ? productSchema : productSchema.partial()).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Confira os dados do produto.', details: parsed.error.flatten() });
    if (req.file) {
      imageUrl = await persistProductImage(req.file);
      uncommittedImageUrl = imageUrl;
    }
    else imageUrl = parsed.data.imageUrl || existing?.imageUrl || null;
    if (!imageUrl) return res.status(400).json({ error: 'Selecione uma foto para o novo produto.' });
    const data = { ...parsed.data, imageUrl };
    const product = create
      ? await prisma.product.create({ data })
      : await prisma.product.update({ where: { id: existing.id }, data });
    uncommittedImageUrl = null;
    if (!create && existing.imageUrl !== product.imageUrl) await removeUnusedProductImage(existing.imageUrl);
    return res.status(create ? 201 : 200).json(product);
  } catch (error) {
    if (uncommittedImageUrl) await removeUnusedProductImage(uncommittedImageUrl);
    if (error instanceof OrderValidationError && error.code === 'INVALID_PRODUCT_IMAGE') return res.status(400).json({ error: error.message });
    throw error;
  } finally {
    if (temporaryUploadPath) {
      try { await fs.promises.unlink(temporaryUploadPath); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Não foi possível limpar o upload temporário do produto:', error); }
    }
  }
}
app.post('/api/admin/products', requireAdmin, handleProductImageUpload, (req, res) => saveAdminProduct(req, res, true));
app.patch('/api/admin/products/:id', requireAdmin, handleProductImageUpload, (req, res) => saveAdminProduct(req, res, false));
app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  const product = await prisma.product.findUnique({ where: { id: req.params.id }, include: { _count: { select: { orderItems: true } } } });
  if (!product) return res.status(404).json({ error: 'Produto não encontrado.' });
  if (product._count.orderItems) return res.status(409).json({ error: 'Este produto já faz parte de pedidos. Desative-o em vez de excluir para preservar o histórico.' });
  await prisma.product.delete({ where: { id: product.id } });
  await removeUnusedProductImage(product.imageUrl);
  res.sendStatus(204);
});
app.get('/api/admin/settings', requireAdmin, async (_req, res) => res.json(await prisma.setting.findUnique({ where: { id: 'main' } })));
app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const parsed = z.object({ deliveryFeeCents: z.number().int().min(0).max(100000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Taxa invalida.' });
  res.json(await prisma.setting.upsert({ where: { id: 'main' }, update: parsed.data, create: parsed.data }));
});

app.get('/api/admin/cash/summary', requireAdmin, async (req, res) => {
  const period = String(req.query.period || 'today');
  const customStart = req.query.from ? String(req.query.from) : null;
  const customEnd = req.query.to ? String(req.query.to) : null;
  const startDate = customStart && parseLocalDate(customStart);
  const endDate = customEnd && parseLocalDate(customEnd);
  if (period === 'custom' && (!startDate || !endDate || startDate > endDate)) return res.status(400).json({ error: 'Período personalizado inválido.' });
  const summary = await getCashSummary(period, customStart, customEnd);
  res.json(summary);
});
app.get('/api/admin/cash/closures', requireAdmin, async (_req, res) => {
  const closures = await prisma.cashClosure.findMany({ orderBy: { closedAt: 'desc' } });
  res.json(closures);
});
app.get('/api/admin/cash/history', requireAdmin, async (req, res) => {
  const period = String(req.query.period || 'today');
  const customStart = req.query.from ? String(req.query.from) : null;
  const customEnd = req.query.to ? String(req.query.to) : null;
  const startDate = customStart && parseLocalDate(customStart);
  const endDate = customEnd && parseLocalDate(customEnd);
  if (period === 'custom' && (!startDate || !endDate || startDate > endDate)) return res.status(400).json({ error: 'Período personalizado inválido.' });
  const summary = await getCashSummary(period, customStart, customEnd);
  const movements = summary.movements.map(item => ({
    date: item.createdAt,
    kind: item.type === 'OPENING' ? 'abertura' : item.type === 'ENTRY' ? 'entrada' : 'saida',
    description: item.description,
    valor: item.amountCents,
    status: item.type
  }));
  res.json({ sales: summary.sales, movements });
});
app.post('/api/admin/cash/open', requireAdmin, async (req, res) => {
  const parsed = z.object({ openingBalanceCents: z.number().int().min(0).max(100000000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Saldo inicial invalido.' });

  const todayWindow = getDateWindow('today');
  const alreadyOpened = await prisma.cashMovement.findFirst({
    where: {
      description: cashOpeningDescription,
      createdAt: { gte: todayWindow.from, lt: todayWindow.to }
    }
  });

  if (alreadyOpened) return res.status(409).json({ error: 'O caixa já foi aberto hoje.' });

  const movement = await prisma.cashMovement.create({
    data: {
      type: 'ENTRY',
      amountCents: parsed.data.openingBalanceCents,
      description: 'Abertura do caixa',
      createdBy: req.admin?.email || 'admin'
    }
  });

  res.status(201).json(movement);
});
app.post('/api/admin/cash/movements', requireAdmin, async (req, res) => {
  const parsed = cashMovementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Movimentacao invalida.' });
  const movement = await prisma.cashMovement.create({
    data: {
      type: parsed.data.type,
      amountCents: parsed.data.amountCents,
      description: parsed.data.description,
      createdBy: req.admin?.email || 'admin'
    }
  });
  res.status(201).json(movement);
});
app.post('/api/admin/cash/close', requireAdmin, async (req, res) => {
  const parsed = cashClosureSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Fechamento invalido.' });

  const todayWindow = getDateWindow('today');
  const alreadyClosed = await prisma.cashClosure.findFirst({
    where: { createdAt: { gte: todayWindow.from, lt: todayWindow.to } }
  });

  if (alreadyClosed) return res.status(409).json({ error: 'Já existe um fechamento para o período atual.' });

  const summary = await getCashSummary('today');
  const closure = await prisma.cashClosure.create({ data: {
    openingBalanceCents: summary.openingBalanceCents,
    totalSoldCents: summary.totalSoldCents,
    totalReceivedCents: summary.totalReceivedCents,
    cashCents: parsed.data.cashCents,
    pixCents: summary.pixCents,
    cardCents: summary.cardCents,
    feesCents: summary.feesCents,
    expensesCents: summary.manualOutputsCents,
    manualEntriesCents: summary.manualEntriesCents,
    manualOutputsCents: summary.manualOutputsCents,
    closingBalanceCents: summary.expectedCashCents,
    profitCents: summary.profitCents,
    closedAt: new Date(),
    createdAt: new Date()
  } });
  res.status(201).json({ ...closure, differenceCents: parsed.data.cashCents - summary.expectedCashCents, profitIsPartial: summary.profitIsPartial });
});

app.use(express.static(__dirname));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(port, '0.0.0.0', () => console.log(`Cantinho Potiguar em ${publicUrl}`));
