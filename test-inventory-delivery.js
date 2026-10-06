import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j87sAAAAASUVORK5CYII=', 'base64');

async function getFreePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForServer(baseUrl, server, getOutput) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      const response = await fetch(`${baseUrl}/api/products`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Inventory test server did not start. ${getOutput()}`);
}

async function json(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const tempDir = await mkdtemp(path.join(root, 'prisma', '.inventory-test-'));
const databaseUrl = `file:./${path.basename(tempDir)}/inventory.db`;
const port = await getFreePort();
const adminEmail = 'inventory-test@example.test';
const adminPassword = 'inventory-test-password';
const uploadDir = path.join(tempDir, 'uploads');
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  UPLOADS_DIR: uploadDir,
  JWT_SECRET: 'inventory-test-jwt-secret',
  MERCADOPAGO_ACCESS_TOKEN: '',
  MERCADOPAGO_ENV: 'test',
  PORT: String(port),
  PUBLIC_URL: `http://127.0.0.1:${port}`,
  CORS_ORIGIN: `http://127.0.0.1:${port}`,
  PRISMA_HIDE_UPDATE_MESSAGE: '1'
};
const baseUrl = `http://127.0.0.1:${port}`;
let server;
let prisma;
let serverOutput = '';

try {
  const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
  const migration = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: root,
    env,
    encoding: 'utf8'
  });
  if (migration.status !== 0) throw new Error(`Temporary database migration failed: ${migration.error?.message || migration.stderr || migration.stdout}`);

  process.env.DATABASE_URL = databaseUrl;
  const { PrismaClient } = await import('@prisma/client');
  prisma = new PrismaClient();
  await prisma.admin.create({ data: { email: adminEmail, passwordHash: await bcrypt.hash(adminPassword, 4) } });

  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });
  await waitForServer(baseUrl, server, () => serverOutput);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'admin login returns the admin cookie');
  const adminHeaders = { Cookie: cookie };

  const form = new FormData();
  form.set('name', 'Marmita de Frango');
  form.set('description', 'Refeição caseira com frango.');
  form.set('category', 'Marmitas');
  form.set('priceCents', '2500');
  form.set('costCents', '800');
  form.set('active', 'true');
  form.set('manualSoldOut', 'false');
  form.set('image', new Blob([imageBytes], { type: 'image/png' }), 'marmita.png');
  const createResponse = await fetch(`${baseUrl}/api/admin/products`, { method: 'POST', headers: adminHeaders, body: form });
  const product = await json(createResponse);
  assert.equal(createResponse.status, 201, JSON.stringify(product));
  assert.equal(product.stock, 0);
  assert.equal(product.category, 'Marmitas');
  assert.match(product.imageUrl, /^\/uploads\/product-/);
  const uploadedPath = path.join(uploadDir, path.basename(product.imageUrl));
  assert.ok(existsSync(uploadedPath), 'uploaded product photo is stored in UPLOADS_DIR');
  const publicImage = await fetch(`${baseUrl}${product.imageUrl}`);
  assert.equal(publicImage.status, 200, 'uploaded product photo is served from its saved URL');

  const editForm = new FormData();
  editForm.set('name', 'Marmita de Frango Especial');
  editForm.set('description', 'Descrição atualizada.');
  editForm.set('category', 'Pratos');
  editForm.set('priceCents', '3000');
  editForm.set('costCents', '900');
  editForm.set('stock', '0');
  editForm.set('active', 'true');
  editForm.set('manualSoldOut', 'false');
  editForm.set('image', new Blob([imageBytes], { type: 'image/png' }), 'marmita-edited.png');
  const editResponse = await fetch(`${baseUrl}/api/admin/products/${product.id}`, { method: 'PATCH', headers: adminHeaders, body: editForm });
  const editedProduct = await json(editResponse);
  assert.equal(editResponse.status, 200, JSON.stringify(editedProduct));
  assert.equal(editedProduct.name, 'Marmita de Frango Especial');
  assert.equal(editedProduct.priceCents, 3000);
  assert.equal(editedProduct.category, 'Pratos');
  assert.equal(existsSync(uploadedPath), false, 'replaced managed product photo is removed');
  assert.equal((await fetch(`${baseUrl}${editedProduct.imageUrl}`)).status, 200);

  const publicCatalog = await json(await fetch(`${baseUrl}/api/products`));
  assert.ok(publicCatalog.some(item => item.id === product.id && item.stock === 0), JSON.stringify({ product, publicCatalog }));
  const adminCatalog = await json(await fetch(`${baseUrl}/api/admin/products`, { headers: adminHeaders }));
  assert.ok(Array.isArray(adminCatalog), JSON.stringify(adminCatalog));
  assert.equal(adminCatalog.find(item => item.id === product.id).manualSoldOut, false);

  const makeOrder = (neighborhood, quantity = 1, deliveryMethod = 'DELIVERY') => fetch(`${baseUrl}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customerName: 'Cliente de teste',
      phone: '84999999999',
      deliveryMethod,
      address: deliveryMethod === 'DELIVERY' ? 'Rua de Teste' : '',
      addressNumber: deliveryMethod === 'DELIVERY' ? '10' : '',
      neighborhood,
      paymentMethod: 'CASH',
      items: [{ productId: product.id, quantity }]
    })
  });

  const blockedNeighborhoods = ['instabul', 'Instabul', 'INSTABUL', ' instabul ', 'Vertentes', 'Vértentes', 'instabull'];
  const orderCountBeforeNeighborhoodChecks = await prisma.order.count();
  for (const neighborhood of blockedNeighborhoods) {
    const response = await makeOrder(neighborhood);
    const result = await json(response);
    assert.equal(response.status, 400, `${neighborhood} must be refused for delivery`);
    assert.match(result.error, /No momento não realizamos entregas neste bairro/);
  }
  assert.equal(await prisma.order.count(), orderCountBeforeNeighborhoodChecks, 'blocked delivery attempts create no orders');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 0, 'blocked attempts do not consume stock');

  const zeroStockOrder = await makeOrder('Mossoró', 11);
  assert.equal(zeroStockOrder.status, 201, 'zero quantity in the stock field does not disable purchase');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 0, 'sales never decrement the stock field');

  const oneUnitOrder = await makeOrder('Ipanema', 1);
  const oneUnitResult = await json(oneUnitOrder);
  assert.equal(oneUnitOrder.status, 201, JSON.stringify(oneUnitResult));
  assert.equal(oneUnitResult.order.deliveryFeeCents, 500, 'existing delivery fee calculation remains intact');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 0);

  const threeUnitOrder = await makeOrder('Mossoró', 3);
  assert.equal(threeUnitOrder.status, 201);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 0);

  const soldOut = await fetch(`${baseUrl}/api/admin/products/${product.id}`, {
    method: 'PATCH',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock: 0 })
  });
  assert.equal(soldOut.status, 200);
  const soldOutCatalog = await json(await fetch(`${baseUrl}/api/products`));
  assert.ok(soldOutCatalog.some(item => item.id === product.id && item.stock === 0), 'active products remain in the catalog at zero stock');
  const orderAtZero = await makeOrder('Mossoró');
  assert.equal(orderAtZero.status, 201, 'zero stock does not mark the product sold out');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 0);

  const restocked = await fetch(`${baseUrl}/api/admin/products/${product.id}`, {
    method: 'PATCH',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ stock: 5 })
  });
  assert.equal(restocked.status, 200);
  assert.equal((await json(await fetch(`${baseUrl}/api/products`))).find(item => item.id === product.id).stock, 5);

  const manuallyUnavailable = await fetch(`${baseUrl}/api/admin/products/${product.id}`, {
    method: 'PATCH',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manualSoldOut: true })
  });
  assert.equal(manuallyUnavailable.status, 200);
  assert.equal((await makeOrder('Mossoró')).status, 409, 'manual sold-out blocks purchase regardless of stock');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 5);

  const reactivated = await fetch(`${baseUrl}/api/admin/products/${product.id}`, {
    method: 'PATCH',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ manualSoldOut: false })
  });
  assert.equal(reactivated.status, 200);
  const fiveUnitOrder = await makeOrder('Mossoró', 5);
  assert.equal(fiveUnitOrder.status, 201);
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 5, 'sales do not decrement positive stock either');

  await prisma.product.update({ where: { id: product.id }, data: { stock: 0 } });
  const pickup = await makeOrder('Vertentes', 1, 'PICKUP');
  const pickupResult = await json(pickup);
  assert.equal(pickup.status, 201, JSON.stringify(pickupResult));
  assert.equal(pickupResult.order.deliveryFeeCents, 0, 'pickup remains valid and has no delivery fee');
  assert.equal((await prisma.product.findUnique({ where: { id: product.id } })).stock, 0);

  const deleteUsedProduct = await fetch(`${baseUrl}/api/admin/products/${product.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(deleteUsedProduct.status, 409, 'product history is protected from destructive deletion');
  const deactivate = await fetch(`${baseUrl}/api/admin/products/${product.id}`, {
    method: 'PATCH',
    headers: { ...adminHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: false })
  });
  assert.equal(deactivate.status, 200);
  assert.ok(!(await json(await fetch(`${baseUrl}/api/products`))).some(item => item.id === product.id), 'inactive product is not offered publicly');

  const disposable = await prisma.product.create({ data: {
    name: 'Produto removível',
    description: '',
    imageUrl: 'https://example.test/disposable.png',
    priceCents: 100,
    stock: 1
  } });
  const deleteUnusedProduct = await fetch(`${baseUrl}/api/admin/products/${disposable.id}`, { method: 'DELETE', headers: adminHeaders });
  assert.equal(deleteUnusedProduct.status, 204, 'unused products can be deleted');

  console.log('Product, upload, stock, neighborhood and pickup integration checks passed.');
} finally {
  if (prisma) await prisma.$disconnect();
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
  await rm(tempDir, { recursive: true, force: true });
}
