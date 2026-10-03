import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const expectedPixKey = '13075085456';

function pixField(id, value) {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

function pixCrc16(value) {
  let crc = 0xffff;
  for (const character of value) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function buildPixPayload(pixKey) {
  const merchantAccount = pixField('00', 'BR.GOV.BCB.PIX') + pixField('01', pixKey);
  const payload = [
    pixField('00', '01'),
    pixField('26', merchantAccount),
    pixField('52', '0000'),
    pixField('53', '986'),
    pixField('58', 'BR'),
    pixField('59', 'QA CANTINHO'),
    pixField('60', 'MOSSORO'),
    '6304'
  ].join('');
  return `${payload}${pixCrc16(payload)}`;
}

async function getFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForServer(baseUrl, server, getOutput) {
  const deadline = Date.now() + 15000;
  let lastStatus = 'sem resposta';
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${baseUrl}/api/products`);
      lastStatus = `HTTP ${response.status}`;
      if (response.ok) return;
    } catch (error) { lastStatus = `${error.message} (${error.cause?.code || 'sem código'})`; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Manual Pix test server did not start (exit ${server.exitCode}, ${lastStatus}). ${getOutput()}`);
}

const tempDir = await mkdtemp(path.join(root, 'prisma', '.manual-pix-test-'));
const databaseUrl = `file:./${path.basename(tempDir)}/manual-pix.db`;
const port = await getFreePort();
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  JWT_SECRET: 'manual-pix-test-jwt-secret',
  MERCADOPAGO_ACCESS_TOKEN: '',
  MERCADOPAGO_ENV: 'test',
  PAYMENT_PAYER_EMAIL: '',
  PIX_KEY: '',
  PIX_QR_PAYLOAD: buildPixPayload(expectedPixKey),
  PORT: String(port),
  PUBLIC_URL: `http://127.0.0.1:${port}`,
  CORS_ORIGIN: `http://127.0.0.1:${port}`,
  PRISMA_HIDE_UPDATE_MESSAGE: '1'
};
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let prisma;
let serverOutput = '';
let uploadedProof;

try {
  const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  const migrationResult = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  if (migrationResult.status !== 0) throw new Error(`Temporary database migration failed: ${migrationResult.error?.message || migrationResult.stderr || migrationResult.stdout}`);

  process.env.DATABASE_URL = databaseUrl;
  const { PrismaClient } = await import('@prisma/client');
  prisma = new PrismaClient();
  const product = await prisma.product.create({ data: {
    name: 'Produto Pix teste',
    description: 'Produto temporário para validar Pix manual.',
    imageUrl: 'https://example.test/pix-test.png',
    priceCents: 2500
  } });
  const secondProduct = await prisma.product.create({ data: {
    name: 'Segundo produto Pix teste',
    description: 'Segundo produto temporário para validar o carrinho.',
    imageUrl: 'https://example.test/pix-test-second.png',
    priceCents: 1800
  } });
  await prisma.$disconnect();
  prisma = null;

  const outputChunks = [];
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.once('spawn', () => { serverOutput += `spawned pid ${server.pid}\n`; });
  server.once('close', (code, signal) => { serverOutput += `closed with code ${code}, signal ${signal}\n`; });
  server.on('error', error => { serverOutput += error.stack || error.message; });
  server.stdout.on('data', chunk => { serverOutput += chunk; outputChunks.push(chunk); });
  server.stderr.on('data', chunk => { serverOutput += chunk; outputChunks.push(chunk); });
  await waitForServer(baseUrl, server, () => serverOutput || Buffer.concat(outputChunks).toString());

  const productsResponse = await fetch(`${baseUrl}/api/products`);
  const products = await productsResponse.json();
  assert.equal(productsResponse.status, 200, JSON.stringify(products));
  assert.ok(products.some(item => item.id === product.id), 'catalog API returns the product used by the cart');

  const settingsResponse = await fetch(`${baseUrl}/api/settings`);
  const settings = await settingsResponse.json();
  assert.equal(settingsResponse.status, 200);
  assert.equal(settings.pix.configured, true);
  assert.equal(settings.pix.qrConfigured, true);
  assert.equal(settings.pix.pixKey, expectedPixKey);
  assert.match(settings.pix.qrCodeDataUrl, /^data:image\/png;base64,/);

  const orderData = {
    customerName: 'Cliente Pix teste',
    phone: '84999999999',
    deliveryMethod: 'DELIVERY',
    address: 'Rua do Teste',
    addressNumber: '15',
    neighborhood: 'Upanema',
    paymentMethod: 'PIX',
    items: [{ productId: product.id, quantity: 2 }, { productId: secondProduct.id, quantity: 1 }]
  };
  const missingProofResponse = await fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(orderData)
  });
  assert.equal(missingProofResponse.status, 400, 'Pix order cannot be created without a proof');

  const orderForm = new FormData();
  for (const [key, value] of Object.entries(orderData)) orderForm.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  orderForm.append('proof', new Blob([Buffer.from('%PDF-1.4\nmanual-pix-test')], { type: 'application/pdf' }), 'receipt.pdf');
  const orderResponse = await fetch(`${baseUrl}/api/orders`, { method: 'POST', body: orderForm });
  const orderResult = await orderResponse.json();
  assert.equal(orderResponse.status, 201, JSON.stringify(orderResult));
  assert.equal(orderResult.payment.type, 'PIX');
  assert.equal(orderResult.payment.pixKey, expectedPixKey);
  assert.equal(orderResult.order.paymentId, null, 'manual Pix does not create a Mercado Pago payment');
  assert.equal(orderResult.order.items.length, 2, 'both selected products are saved and returned');
  assert.deepEqual(orderResult.order.items.map(item => [item.productId, item.productName, item.quantity, item.unitPriceCents]), [
    [product.id, product.name, 2, 2500],
    [secondProduct.id, secondProduct.name, 1, 1800]
  ]);
  assert.equal(orderResult.order.subtotal, 68, 'the backend calculates the product subtotal from the database');
  assert.equal(orderResult.order.deliveryFee, 5, 'the backend calculates the delivery fee from the selected neighborhood');
  assert.equal(orderResult.order.total, 73, 'subtotal plus delivery equals the stored total');

  assert.equal(orderResult.order.pixProofStatus, 'SENT', 'proof is saved with the order');
  uploadedProof = path.join(root, 'uploads', path.basename(orderResult.order.pixProofUrl));

  const invalidProof = new FormData();
  invalidProof.append('proof', new Blob(['not an image'], { type: 'image/jpeg' }), 'invalid.jpg');
  for (const [key, value] of Object.entries(orderData)) invalidProof.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  const invalidResponse = await fetch(`${baseUrl}/api/orders`, { method: 'POST', body: invalidProof });
  assert.equal(invalidResponse.status, 400, 'file signatures are checked by the backend');

  const oversizedProof = new FormData();
  oversizedProof.append('proof', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], { type: 'application/pdf' }), 'large.pdf');
  for (const [key, value] of Object.entries(orderData)) oversizedProof.append(key, typeof value === 'string' ? value : JSON.stringify(value));
  const oversizedResponse = await fetch(`${baseUrl}/api/orders`, { method: 'POST', body: oversizedProof });
  const oversizedResult = await oversizedResponse.json();
  assert.equal(oversizedResponse.status, 413, JSON.stringify(oversizedResult));

  console.log('Manual Pix API passed without Mercado Pago credentials.');
} finally {
  if (prisma) await prisma.$disconnect();
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
  if (uploadedProof) await rm(uploadedProof, { force: true });
  await rm(tempDir, { recursive: true, force: true });
}