import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = await mkdtemp(path.join(root, '.payment-options-test-'));
const databaseUrl = `file:./${path.relative(path.join(root, 'prisma'), path.join(temporaryRoot, 'payments.db')).replaceAll('\\', '/')}`;
const uploadsDir = path.join(temporaryRoot, 'uploads');
const adminEmail = 'payment-options@example.test';
const adminPassword = 'payment-options-test';
let server;
let prisma;
let serverOutput = '';

async function getFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function startServer() {
  const port = await getFreePort();
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    UPLOADS_DIR: uploadsDir,
    JWT_SECRET: 'payment-options-test-jwt-secret',
    MERCADOPAGO_ACCESS_TOKEN: '',
    PIX_KEY: '13075085456',
    PORT: String(port),
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGIN: `http://127.0.0.1:${port}`,
    PRISMA_HIDE_UPDATE_MESSAGE: '1'
  };
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      if ((await fetch(`${baseUrl}/api/products`)).ok) return baseUrl;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start. ${serverOutput}`);
}

async function stopServer() {
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
  server = null;
}

try {
  const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  const migration = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    encoding: 'utf8'
  });
  if (migration.status !== 0) throw new Error(`Temporary database migration failed: ${migration.error?.message || migration.stderr || migration.stdout}`);

  process.env.DATABASE_URL = databaseUrl;
  const { PrismaClient } = await import('@prisma/client');
  prisma = new PrismaClient();
  await prisma.admin.create({ data: { email: adminEmail, passwordHash: await bcrypt.hash(adminPassword, 4) } });
  const product = await prisma.product.create({ data: {
    name: 'Produto pagamento',
    description: 'Produto usado nos testes de formas de pagamento.',
    imageUrl: 'https://example.test/original.jpg',
    priceCents: 2500
  } });
  await prisma.$disconnect();
  prisma = null;

  let baseUrl = await startServer();
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const makeOrder = async (paymentMethod, extra = {}) => fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: `Teste ${paymentMethod}`,
      phone: '84999999999',
      deliveryMethod: 'DELIVERY',
      address: 'Rua de teste',
      addressNumber: '10',
      neighborhood: 'Mossoró',
      paymentMethod,
      items: [{ productId: product.id, quantity: 1 }],
      ...extra
    })
  });

  const insufficientCash = await makeOrder('CASH', { cashTenderedCents: 2500 });
  assert.equal(insufficientCash.status, 400, 'cash amount below total is rejected');

  const checkoutToken = '9e4137a9-e827-4d45-966a-1297f78f4de0';
  const cashResponse = await makeOrder('CASH', { cashTenderedCents: 5000, checkoutToken });
  const cashResult = await cashResponse.json();
  assert.equal(cashResponse.status, 201, JSON.stringify(cashResult));
  assert.equal(cashResult.order.totalCents, 2700, 'server calculates total including delivery');
  assert.equal(cashResult.order.cashTenderedCents, 5000);
  assert.equal(cashResult.order.cashChangeCents, 2300);
  assert.equal(cashResult.order.paymentStatus, 'PENDING');
  assert.equal(cashResult.order.orderStatus, 'RECEIVED');

  const repeatedCashResponse = await makeOrder('CASH', { cashTenderedCents: 5000, checkoutToken });
  const repeatedCashResult = await repeatedCashResponse.json();
  assert.equal(repeatedCashResponse.status, 200);
  assert.equal(repeatedCashResult.order.id, cashResult.order.id, 'repeated checkout token returns the original order');

  const noChangeResponse = await makeOrder('CASH');
  const noChangeResult = await noChangeResponse.json();
  assert.equal(noChangeResponse.status, 201, JSON.stringify(noChangeResult));
  assert.equal(noChangeResult.order.cashTenderedCents, null);
  assert.equal(noChangeResult.order.cashChangeCents, null);

  const cardResponse = await makeOrder('CARD_ON_DELIVERY');
  const cardResult = await cardResponse.json();
  assert.equal(cardResponse.status, 201, JSON.stringify(cardResult));
  assert.equal(cardResult.payment.type, 'CARD_ON_DELIVERY');
  assert.equal(cardResult.order.paymentStatus, 'PENDING');
  assert.equal(cardResult.order.paymentId, null);

  const unauthorizedStatus = await fetch(`${baseUrl}/api/admin/orders/${cardResult.order.id}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAID' })
  });
  assert.equal(unauthorizedStatus.status, 401, 'customers cannot change payment status');

  const markCardPaid = await fetch(`${baseUrl}/api/admin/orders/${cardResult.order.id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAID' })
  });
  assert.equal(markCardPaid.status, 200);
  assert.equal((await markCardPaid.json()).paymentStatus, 'APPROVED', 'authorized staff confirmation records receipt');

  const markCashPaid = await fetch(`${baseUrl}/api/admin/orders/${cashResult.order.id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAID' })
  });
  assert.equal(markCashPaid.status, 200);
  assert.equal((await markCashPaid.json()).paymentStatus, 'APPROVED', 'cash remains pending until staff confirms receipt');

  const pixForm = new FormData();
  for (const [key, value] of Object.entries({
    customerName: 'Teste Pix',
    phone: '84999999999',
    deliveryMethod: 'DELIVERY',
    address: 'Rua de teste',
    addressNumber: '10',
    neighborhood: 'Mossoró',
    paymentMethod: 'PIX',
    items: JSON.stringify([{ productId: product.id, quantity: 1 }])
  })) pixForm.set(key, value);
  pixForm.append('proof', new Blob([Buffer.from('%PDF-1.4\npayment-options-test')], { type: 'application/pdf' }), 'receipt.pdf');
  const pixResponse = await fetch(`${baseUrl}/api/orders`, { method: 'POST', body: pixForm });
  const pixResult = await pixResponse.json();
  assert.equal(pixResponse.status, 201, JSON.stringify(pixResult));
  assert.equal(pixResult.order.paymentStatus, 'PENDING', 'Pix selection and proof upload do not confirm payment');
  assert.equal(pixResult.order.orderStatus, 'PAYMENT_PENDING');
  const directPixPaid = await fetch(`${baseUrl}/api/admin/orders/${pixResult.order.id}/status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'PAID' })
  });
  assert.equal(directPixPaid.status, 409, 'Pix must be confirmed through proof review');
  const confirmPix = await fetch(`${baseUrl}/api/admin/orders/${pixResult.order.id}/proof-status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CONFIRMED' })
  });
  assert.equal(confirmPix.status, 200);
  assert.equal((await confirmPix.json()).paymentStatus, 'APPROVED', 'Pix can be approved only after authorized proof confirmation');

  const adminOrdersResponse = await fetch(`${baseUrl}/api/admin/orders`, { headers: { Cookie: cookie } });
  const adminOrders = await adminOrdersResponse.json();
  const adminCashOrder = adminOrders.find(order => order.id === cashResult.order.id);
  assert.equal(adminCashOrder.paymentMethod, 'CASH');
  assert.equal(adminCashOrder.cashTenderedCents, 5000);
  assert.equal(adminCashOrder.cashChangeCents, 2300);

  const imageForm = new FormData();
  imageForm.set('name', product.name);
  imageForm.set('description', product.description);
  imageForm.set('category', 'Geral');
  imageForm.set('priceCents', '2500');
  imageForm.set('active', 'true');
  imageForm.set('manualSoldOut', 'false');
  imageForm.append('image', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01])], { type: 'image/jpeg' }), 'new-photo.jpg');
  const imageResponse = await fetch(`${baseUrl}/api/admin/products/${product.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie },
    body: imageForm
  });
  const updatedProduct = await imageResponse.json();
  assert.equal(imageResponse.status, 200, JSON.stringify(updatedProduct));
  assert.match(updatedProduct.imageUrl, /^\/uploads\/product-/);
  const imageUrlBeforeRestart = updatedProduct.imageUrl;
  const settingsUpdate = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryFeeCents: 875 })
  });
  assert.equal(settingsUpdate.status, 200);
  const imageBeforeRestart = await fetch(`${baseUrl}${imageUrlBeforeRestart}`);
  assert.equal(imageBeforeRestart.status, 200);

  await stopServer();
  baseUrl = await startServer();
  const productsResponse = await fetch(`${baseUrl}/api/products`);
  const products = await productsResponse.json();
  const persistedProduct = products.find(item => item.id === product.id);
  assert.equal(persistedProduct.imageUrl, imageUrlBeforeRestart, 'product image record persists after server restart');
  const persistedImage = await fetch(`${baseUrl}${persistedProduct.imageUrl}`);
  assert.equal(persistedImage.status, 200, 'uploaded product image persists after server restart');
  assert.deepEqual([...new Uint8Array(await persistedImage.arrayBuffer())], [0xff, 0xd8, 0xff, 0x00, 0x01]);
  const persistedSettingsResponse = await fetch(`${baseUrl}/api/admin/settings`, { headers: { Cookie: cookie } });
  assert.equal((await persistedSettingsResponse.json()).deliveryFeeCents, 875, 'site settings persist after server restart');

  console.log('Payment options, authorized status transitions, and image/settings persistence tests passed.');
} finally {
  await stopServer();
  if (prisma) await prisma.$disconnect();
  await rm(temporaryRoot, { recursive: true, force: true });
}
