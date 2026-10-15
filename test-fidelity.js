import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const temporaryRoot = await mkdtemp(path.join(root, '.fidelity-test-'));
const databaseUrl = `file:./${path.relative(path.join(root, 'prisma'), path.join(temporaryRoot, 'fidelity.db')).replaceAll('\\', '/')}`;
const adminEmail = 'fidelity-test@example.test';
const adminPassword = 'fidelity-test-password';
let server;
let prisma;
let output = '';

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
    UPLOADS_DIR: path.join(temporaryRoot, 'uploads'),
    JWT_SECRET: 'fidelity-test-jwt-secret',
    MERCADOPAGO_ACCESS_TOKEN: '',
    PIX_KEY: '13075085456',
    PORT: String(port),
    PUBLIC_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGIN: `http://127.0.0.1:${port}`,
    PRISMA_HIDE_UPDATE_MESSAGE: '1'
  };
  server = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && server.exitCode === null) {
    try {
      if ((await fetch(`${baseUrl}/api/products`)).ok) return baseUrl;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Fidelity test server did not start. ${output}`);
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
  const products = await Promise.all([
    prisma.product.create({ data: { name: 'Marmita Fidelidade A', description: 'Teste', imageUrl: 'https://example.test/a.jpg', priceCents: 1500 } }),
    prisma.product.create({ data: { name: 'Marmita Fidelidade B', description: 'Teste', imageUrl: 'https://example.test/b.jpg', priceCents: 1800 } })
  ]);
  const baseUrl = await startServer();
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: adminEmail, password: adminPassword })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  assert.equal((await fetch(`${baseUrl}/api/admin/fidelity`)).status, 401, 'fidelity account data is protected by admin auth');

  const createOrder = async (phone, items, checkoutToken) => {
    const body = {
      customerName: 'Cliente fidelidade',
      phone,
      deliveryMethod: 'PICKUP',
      paymentMethod: 'CASH',
      items: items.map(([index, quantity]) => ({ productId: products[index].id, quantity })),
      ...(checkoutToken ? { checkoutToken } : {})
    };
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    assert.ok(response.status === 201 || response.status === 200, JSON.stringify(result));
    return { response, result };
  };

  const status = async (orderId, nextStatus, expected = 200) => {
    const response = await fetch(`${baseUrl}/api/admin/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  };

  const completeOrder = async (phone, items, checkoutToken) => {
    const { result } = await createOrder(phone, items, checkoutToken);
    if (result.order.orderStatus !== 'COMPLETED') {
      await status(result.order.id, 'PAID');
      await status(result.order.id, 'COMPLETED');
    }
    return result.order;
  };

  const firstOrderResponse = await createOrder('84999999999', [[0, 5]]);
  assert.equal(firstOrderResponse.result.fidelity.points, 0, 'pending order does not increase the public message counter');
  assert.equal(firstOrderResponse.result.fidelity.validOrdersCount, 0);
  let current = firstOrderResponse.result.order;
  await status(current.id, 'PAID');
  await status(current.id, 'COMPLETED');
  assert.equal(current.items[0].quantity, 5);
  let account = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84999999999' } });
  assert.equal(account.points, 1, 'five units in one order earn one stamp');

  const duplicateToken = '91f4fa84-b74f-4924-bde5-03b92fa8addb';
  const distinctItems = await createOrder('+55 (84) 99999-9999', [[0, 1], [1, 1]], duplicateToken);
  const duplicate = await createOrder('84999999999', [[0, 5]], duplicateToken);
  assert.equal(duplicate.result.order.id, distinctItems.result.order.id, 'repeated checkout token resolves to the same order');
  assert.equal(distinctItems.result.fidelity.points, 1, 'new order message uses the current database progress');
  assert.equal(distinctItems.result.fidelity.validOrdersCount, 1);
  assert.equal(distinctItems.result.fidelity.rewardsEarned, 0);
  assert.equal(Object.hasOwn(distinctItems.result.order, 'phoneNormalized'), false, 'public order responses do not expose normalized phone identifiers');
  await status(distinctItems.result.order.id, 'COMPLETED');
  account = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84999999999' } });
  assert.equal(account.points, 1, 'completion alone is insufficient before payment confirmation');
  await status(distinctItems.result.order.id, 'PAID');
  account = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84999999999' } });
  assert.equal(account.points, 1, 'paid but incomplete order does not grant a stamp');
  await status(distinctItems.result.order.id, 'COMPLETED');
  await status(distinctItems.result.order.id, 'COMPLETED');
  account = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84999999999' } });
  assert.equal(account.points, 2, 'two different products still grant one stamp, without duplicate status awards');
  assert.equal(account.validOrdersCount, 2);
  assert.equal(await prisma.fidelityAccount.count(), 1, 'phone formatting does not create another card');

  await completeOrder('84999999999', [[1, 1]]);
  await completeOrder('84999999999', [[0, 2], [1, 1]]);
  await completeOrder('84999999999', [[0, 1]]);
  await completeOrder('84999999999', [[1, 5]]);
  await completeOrder('84999999999', [[0, 1]]);
  await completeOrder('84999999999', [[1, 1]]);
  await completeOrder('84999999999', [[0, 3]]);
  await completeOrder('84999999999', [[0, 1]]);
  account = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84999999999' } });
  assert.equal(account.points, 10, 'ten separate valid orders fill a single card');
  assert.equal(account.validOrdersCount, 10);
  let rewards = await prisma.fidelityReward.findMany({ where: { accountId: account.id } });
  assert.equal(rewards.length, 1, 'a single reward is issued when the tenth distinct order is completed');
  assert.equal(rewards[0].status, 'AVAILABLE');
  const rewardProgress = await createOrder('84999999999', [[0, 1]]);
  assert.equal(rewardProgress.result.fidelity.points, 10, 'tenth completed order displays a full card');
  assert.equal(rewardProgress.result.fidelity.rewardAvailable, true, 'message reports the earned reward');
  assert.equal(rewardProgress.result.fidelity.remaining, 0);
  assert.equal(rewardProgress.result.fidelity.rewardsEarned, 1);
  await status(rewardProgress.result.order.id, 'CANCELLED');

  const adminCardsResponse = await fetch(`${baseUrl}/api/admin/fidelity`, { headers: { Cookie: cookie } });
  assert.equal(adminCardsResponse.status, 200);
  const adminCard = (await adminCardsResponse.json()).find(item => item.phoneNormalized === '84999999999');
  assert.equal(adminCard.points, rewardProgress.result.fidelity.points, 'admin and customer message use the same progress');
  assert.equal(adminCard.validOrdersCount, rewardProgress.result.fidelity.validOrdersCount);
  assert.equal(adminCard.rewards.length, rewardProgress.result.fidelity.rewardsEarned);

  await completeOrder('84999999999', [[0, 1]]);
  await completeOrder('84999999999', [[1, 1]]);
  account = await prisma.fidelityAccount.findUnique({ where: { id: account.id } });
  assert.equal(account.queuedPoints, 2, 'orders after an unredeemed reward are queued and preserved');

  const earnedOrder = await prisma.fidelityEvent.findFirst({
    where: { accountId: account.id, type: 'POINT_EARNED', cycle: 1 },
    orderBy: { createdAt: 'asc' }
  });
  const orderToCancel = await prisma.order.findUnique({ where: { id: earnedOrder.orderId } });
  await status(orderToCancel.id, 'CANCELLED');
  rewards = await prisma.fidelityReward.findMany({ where: { accountId: account.id } });
  assert.equal(rewards[0].status, 'REVIEW_REQUIRED', 'cancellation after reward issuance freezes it for explicit review');
  account = await prisma.fidelityAccount.findUnique({ where: { id: account.id } });
  assert.equal(account.reviewRequired, true);
  const pendingReview = await prisma.fidelityEvent.findFirst({
    where: { orderId: orderToCancel.id, type: 'POINT_REVERSED', pointsDelta: 0 }
  });
  assert.ok(pendingReview, 'cancellation is recorded without silently deleting loyalty history');
  const blockedRedemption = await fetch(`${baseUrl}/api/admin/fidelity/rewards/${rewards[0].id}/redeem`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(blockedRedemption.status, 409, 'review-required rewards cannot be redeemed');

  const resolveReview = await fetch(`${baseUrl}/api/admin/fidelity/events/${pendingReview.id}/resolve`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resolution: 'HONOR', note: 'Pedido validado pela gerência.' })
  });
  assert.equal(resolveReview.status, 200);
  const redeemed = await fetch(`${baseUrl}/api/admin/fidelity/rewards/${rewards[0].id}/redeem`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(redeemed.status, 200);
  const duplicateRedemption = await fetch(`${baseUrl}/api/admin/fidelity/rewards/${rewards[0].id}/redeem`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(duplicateRedemption.status, 409, 'a reward cannot be redeemed twice');
  account = await prisma.fidelityAccount.findUnique({ where: { id: account.id } });
  assert.equal(account.points, 2, 'queued points start the next cycle once reward is redeemed');
  assert.equal(account.queuedPoints, 0);
  const nextCycleProgress = await createOrder('84999999999', [[1, 1]]);
  assert.equal(nextCycleProgress.result.fidelity.points, 2, 'progress continues after the prior reward is redeemed');
  assert.equal(nextCycleProgress.result.fidelity.validOrdersCount, 12, 'lifetime valid-order history is retained');
  assert.equal(nextCycleProgress.result.fidelity.rewardsEarned, 1, 'previously earned rewards remain in the history');
  assert.equal(nextCycleProgress.result.fidelity.rewardAvailable, false);
  await status(nextCycleProgress.result.order.id, 'CANCELLED');

  const secondCustomerOrder = await completeOrder('84988887777', [[0, 1]]);
  assert.equal(Object.hasOwn(secondCustomerOrder, 'phoneNormalized'), false, 'normalized phone identifier is not returned to public clients');
  const accounts = await prisma.fidelityAccount.findMany();
  assert.equal(accounts.length, 2, 'different customer phone numbers have independent cards');
  const secondAccount = accounts.find(item => item.phoneNormalized === '84988887777');
  assert.equal(secondAccount.points, 1);
  assert.equal(secondAccount.validOrdersCount, 1);

  const cancelled = await createOrder('84977776666', [[0, 1]]);
  await status(cancelled.result.order.id, 'CANCELLED');
  assert.equal(await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84977776666' } }).then(item => item.points), 0, 'an uncompleted cancelled order earns no point');

  await stopServer();
  const restartedBaseUrl = await startServer();
  const persistedCardsResponse = await fetch(`${restartedBaseUrl}/api/admin/fidelity`, { headers: { Cookie: cookie } });
  assert.equal(persistedCardsResponse.status, 200, 'admin card history remains available after the server restarts');
  const persistedCard = (await persistedCardsResponse.json()).find(item => item.phoneNormalized === '84999999999');
  assert.equal(persistedCard.validOrdersCount, 12, 'server restart does not erase the loyalty history');
  assert.equal(persistedCard.rewards.length, 1);

  console.log('Digital loyalty eligibility, per-order idempotency, rewards, cancellation review, phone normalization, and account separation passed.');
} finally {
  await stopServer();
  if (prisma) await prisma.$disconnect();
  await rm(temporaryRoot, { recursive: true, force: true });
}
