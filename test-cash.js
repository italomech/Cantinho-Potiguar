import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const adminEmail = 'cash-test@example.test';
const adminPassword = 'cash-test-password';

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
  throw new Error(`Cash test server did not start. ${getOutput()}`);
}

async function runScenario(closeDifferenceCents) {
  const tempDir = await mkdtemp(path.join(root, 'prisma', '.cash-test-'));
  const databasePath = path.join(tempDir, 'cash.db');
  const databaseUrl = `file:./${path.basename(tempDir)}/cash.db`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: 'cash-test-jwt-secret',
    MERCADOPAGO_ACCESS_TOKEN: '',
    MERCADOPAGO_ENV: 'test',
    PAYMENT_PAYER_EMAIL: 'cash-test@example.test',
    PORT: String(await getFreePort()),
    PUBLIC_URL: 'http://127.0.0.1',
    CORS_ORIGIN: 'http://127.0.0.1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1'
  };
  const baseUrl = `http://127.0.0.1:${env.PORT}`;
  let server;
  let prisma;
  let serverOutput = '';
  const previousDatabaseUrl = process.env.DATABASE_URL;

  try {
    const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
    const pushResult = spawnSync(process.execPath, [prismaCli, 'db', 'push', '--schema', 'prisma/schema.prisma', '--skip-generate'], {
      cwd: root,
      env,
      encoding: 'utf8'
    });
    if (pushResult.status !== 0) throw new Error(`Temporary database setup failed: ${pushResult.error?.message || pushResult.stderr || pushResult.stdout}`);

    process.env.DATABASE_URL = databaseUrl;
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient();
    await prisma.admin.create({ data: { email: adminEmail, passwordHash: await bcrypt.hash(adminPassword, 4) } });
    const product = await prisma.product.create({ data: {
      name: 'Produto de teste',
      description: 'Produto temporário para validar o Caixa.',
      imageUrl: 'https://example.test/product.png',
      priceCents: 2500,
      stock: 10,
      costCents: 800
    } });
    const productWithoutCost = await prisma.product.create({ data: {
      name: 'Produto sem custo de teste',
      description: 'Produto temporário sem custo conhecido.',
      imageUrl: 'https://example.test/product-without-cost.png',
      priceCents: 1800,
      stock: 10
    } });

    const createPaidOrder = async (paymentMethod, quantity, paymentStatus = 'APPROVED', orderStatus = 'PAID', feeCents = 0) => prisma.order.create({
      data: {
        customerName: `${paymentMethod} teste`,
        phone: '84999999999',
        deliveryMethod: 'PICKUP',
        subtotalCents: 2500 * quantity,
        deliveryFeeCents: 0,
        totalCents: 2500 * quantity,
        feeCents,
        paymentMethod,
        paymentStatus,
        orderStatus,
        items: { create: [{ productId: product.id, productName: product.name, unitPriceCents: 2500, quantity }] }
      }
    });

    await createPaidOrder('PIX', 2, 'APPROVED', 'PAID', 100);
    await createPaidOrder('CARD', 1);
    await createPaidOrder('CARD', 1, 'APPROVED', 'CANCELLED');
    await createPaidOrder('PIX', 1, 'PENDING', 'PAYMENT_PENDING');
    await prisma.order.create({
      data: {
        customerName: 'Venda sem custo cadastrado',
        phone: '84999999999',
        deliveryMethod: 'PICKUP',
        subtotalCents: 1800,
        deliveryFeeCents: 0,
        totalCents: 1800,
        paymentMethod: 'PIX',
        paymentStatus: 'APPROVED',
        orderStatus: 'PAID',
        items: { create: [{ productId: productWithoutCost.id, productName: productWithoutCost.name, unitPriceCents: 1800, quantity: 1 }] }
      }
    });
    await prisma.$disconnect();
    prisma = null;

    const outputChunks = [];
    server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { serverOutput += chunk; outputChunks.push(chunk); });
    server.stderr.on('data', chunk => { serverOutput += chunk; outputChunks.push(chunk); });
    await waitForServer(baseUrl, server, () => Buffer.concat(outputChunks).toString());

    const loginResponse = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword })
    });
    assert.equal(loginResponse.status, 200, 'admin test login');
    const cookie = loginResponse.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie, 'admin session cookie');

    const api = async (route, { method = 'GET', body, expectedStatus = 200 } = {}) => {
      const response = await fetch(`${baseUrl}${route}`, {
        method,
        headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const result = response.status === 204 ? null : await response.json();
      assert.equal(response.status, expectedStatus, `${method} ${route}: ${JSON.stringify(result)}`);
      return result;
    };

    const opening = await api('/api/admin/cash/open', { method: 'POST', body: { openingBalanceCents: 10000 }, expectedStatus: 201 });
    assert.equal(opening.amountCents, 10000, 'opening cash is stored');
    await api('/api/admin/cash/open', { method: 'POST', body: { openingBalanceCents: 10000 }, expectedStatus: 409 });

    await api('/api/admin/cash/movements', { method: 'POST', body: { type: 'ENTRY', amountCents: 2000, description: 'Entrada API teste' }, expectedStatus: 201 });
    await api('/api/admin/cash/movements', { method: 'POST', body: { type: 'OUTPUT', amountCents: 1500, description: 'Saída API teste' }, expectedStatus: 201 });

    const cashOrderResponse = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Venda em dinheiro',
        phone: '84999999999',
        deliveryMethod: 'PICKUP',
        paymentMethod: 'CASH',
        items: [{ productId: product.id, quantity: 1 }]
      })
    });
    const cashOrderResult = await cashOrderResponse.json();
    assert.equal(cashOrderResponse.status, 201, JSON.stringify(cashOrderResult));
    assert.equal(cashOrderResult.payment.type, 'CASH', 'cash checkout does not require Mercado Pago');

    let summary = await api('/api/admin/cash/summary?period=today');
    assert.equal(summary.openingBalanceCents, 10000, 'opening balance is included');
    assert.equal(summary.cashSalesCents, 0, 'unpaid cash order is excluded');
    assert.equal(summary.pixCents, 6800);
    assert.equal(summary.cardCents, 2500);
    assert.equal(summary.expectedCashCents, 10500, 'Pix/card do not affect physical cash; one output deducted');

    await api(`/api/admin/orders/${cashOrderResult.order.id}/status`, { method: 'PATCH', body: { status: 'PAID' } });
    await api(`/api/admin/orders/${cashOrderResult.order.id}/status`, { method: 'PATCH', body: { status: 'PREPARING' } });
    summary = await api('/api/admin/cash/summary?period=today');
    assert.equal(summary.approvedOrdersCount, 4, 'pending and cancelled orders are excluded');
    assert.equal(summary.totalSoldCents, 11800, 'each valid order is counted once');
    assert.equal(summary.cashSalesCents, 2500);
    assert.equal(summary.pixCents, 6800);
    assert.equal(summary.cardCents, 2500);
    assert.equal(summary.manualEntriesCents, 2000);
    assert.equal(summary.manualOutputsCents, 1500);
    assert.equal(summary.expectedCashCents, 13000, 'cash balance includes opening, cash sales and movements once');
    assert.equal(summary.costOfGoodsCents, 3200, 'Product.costCents is multiplied by sold quantities');
    assert.equal(summary.feesCents, 100, 'a stored real fee is included');
    assert.equal(summary.feesUnavailableOrdersCount, 2, 'missing Mercado Pago fees are disclosed');
    assert.equal(summary.costUnavailableItemsCount, 1, 'missing cost is reported rather than invented');
    assert.equal(summary.profitCents, 8500);
    assert.equal(summary.profitIsPartial, true, 'missing real fee data is disclosed');

    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const customSummary = await api(`/api/admin/cash/summary?period=custom&from=${date}&to=${date}`);
    assert.equal(customSummary.totalSoldCents, summary.totalSoldCents, 'custom local-date filter includes the full selected day');
    const history = await api(`/api/admin/cash/history?period=custom&from=${date}&to=${date}`);
    assert.equal(history.sales.length, 4, 'history includes each valid sale once');
    assert.ok(history.movements.some(item => item.kind === 'abertura'), 'history includes opening movement');
    assert.equal(history.movements.filter(item => item.kind === 'entrada').length, 1);
    assert.equal(history.movements.filter(item => item.kind === 'saida').length, 1);

    const countedCents = summary.expectedCashCents + closeDifferenceCents;
    const closure = await api('/api/admin/cash/close', { method: 'POST', body: { cashCents: countedCents }, expectedStatus: 201 });
    assert.equal(closure.closingBalanceCents, summary.expectedCashCents, 'closure stores server-calculated expected balance');
    assert.equal(closure.cashCents, countedCents, 'closure stores operator count');
    assert.equal(closure.differenceCents, closeDifferenceCents, 'closure returns counted minus expected');
    await api('/api/admin/cash/close', { method: 'POST', body: { cashCents: countedCents }, expectedStatus: 409 });
    const closures = await api('/api/admin/cash/closures');
    assert.equal(closures.length, 1);
    assert.equal(closures[0].cashCents - closures[0].closingBalanceCents, closeDifferenceCents);
  } finally {
    if (prisma) await prisma.$disconnect();
    if (server && server.exitCode === null) {
      const stopped = once(server, 'exit');
      server.kill();
      await stopped;
    }
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    await rm(tempDir, { recursive: true, force: true });
  }
}

for (const difference of [0, -500]) {
  await runScenario(difference);
  console.log(`Cash scenario passed: difference ${difference} cents.`);
}