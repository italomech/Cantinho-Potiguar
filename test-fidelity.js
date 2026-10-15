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

  const createPixOrder = async (phone, items, checkoutToken) => {
    const body = {
      customerName: 'Cliente Pix fidelidade',
      phone,
      deliveryMethod: 'PICKUP',
      paymentMethod: 'PIX',
      items: JSON.stringify(items.map(([index, quantity]) => ({ productId: products[index].id, quantity }))),
      checkoutToken
    };
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) form.append(key, value);
    form.append('proof', new Blob([Buffer.from('%PDF-1.4\nfidelity-pix-test')], { type: 'application/pdf' }), 'receipt.pdf');
    const response = await fetch(`${baseUrl}/api/orders`, { method: 'POST', body: form });
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

  const pixTokens = [
    'a7171e66-d327-4238-a048-c656afbb27fb',
    '6f708365-1ad2-45c2-bff1-5724f9ea2d91'
  ];
  const firstPixOrder = await createPixOrder('84977770001', [[0, 1]], pixTokens[0]);
  assert.equal(firstPixOrder.result.fidelity.points, 1, 'Pix proof adds an immediate provisional stamp');
  assert.equal(firstPixOrder.result.fidelity.provisionalPoints, 1);
  assert.equal(firstPixOrder.result.fidelity.validOrdersCount, 0, 'provisional credit is not yet a validated order');
  const duplicatePixOrder = await createPixOrder('84977770001', [[0, 1]], pixTokens[0]);
  assert.equal(duplicatePixOrder.result.order.id, firstPixOrder.result.order.id, 'repeated Pix checkout token resolves to the same order');
  assert.equal(duplicatePixOrder.result.fidelity.points, 1, 'repeated Pix checkout does not issue another provisional stamp');
  const storedProgress = await fetch(`${baseUrl}/api/fidelity/progress?checkoutToken=${pixTokens[0]}`);
  assert.equal(storedProgress.status, 200, 'customer can restore the card using its private checkout token');
  assert.equal((await storedProgress.json()).points, 1);
  const secondPixOrder = await createPixOrder('84977770001', [[1, 1]], pixTokens[1]);
  assert.equal(secondPixOrder.result.fidelity.points, 2, 'subsequent Pix proofs immediately add the next stamp');
  assert.equal(secondPixOrder.result.fidelity.provisionalPoints, 2);
  const rejectPix = await fetch(`${baseUrl}/api/admin/orders/${firstPixOrder.result.order.id}/proof-status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'REJECTED' })
  });
  assert.equal(rejectPix.status, 200);
  let pixAccount = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84977770001' } });
  assert.equal(pixAccount.points, 1, 'rejecting one order removes only its linked provisional stamp');
  assert.equal(pixAccount.validOrdersCount, 0);
  assert.equal(await prisma.fidelityEvent.findUnique({ where: { idempotencyKey: `order-earned:${firstPixOrder.result.order.id}` } }).then(event => event.creditStatus), 'REJECTED');
  const confirmPix = await fetch(`${baseUrl}/api/admin/orders/${secondPixOrder.result.order.id}/proof-status`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'CONFIRMED' })
  });
  assert.equal(confirmPix.status, 200);
  const confirmedEvent = await prisma.fidelityEvent.findUnique({ where: { idempotencyKey: `order-earned:${secondPixOrder.result.order.id}` } });
  assert.equal(confirmedEvent.creditStatus, 'CONFIRMED');
  pixAccount = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84977770001' } });
  assert.equal(pixAccount.points, 1, 'confirming the payment promotes but does not duplicate the provisional stamp');
  await status(secondPixOrder.result.order.id, 'COMPLETED');
  await status(secondPixOrder.result.order.id, 'COMPLETED');
  pixAccount = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84977770001' } });
  assert.equal(pixAccount.points, 1, 'completing a confirmed Pix order does not add a second stamp');
  assert.equal(pixAccount.validOrdersCount, 1, 'the order enters the validated count once after completion');

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
  assert.equal(await prisma.fidelityAccount.count({ where: { phoneNormalized: '84999999999' } }), 1, 'phone formatting does not create another card');

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
  assert.equal(accounts.length, 3, 'different customer phone numbers have independent cards');
  const secondAccount = accounts.find(item => item.phoneNormalized === '84988887777');
  assert.equal(secondAccount.points, 1);
  assert.equal(secondAccount.validOrdersCount, 1);

  const rewardTokens = Array.from({ length: 10 }, (_, index) => `b0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const rewardPixOrders = [];
  for (const token of rewardTokens) rewardPixOrders.push(await createPixOrder('84966665555', [[0, 1]], token));
  let rewardTestAccount = await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84966665555' } });
  assert.equal(rewardTestAccount.points, 10);
  assert.equal(rewardTestAccount.validOrdersCount, 0);
  assert.equal(await prisma.fidelityReward.count({ where: { accountId: rewardTestAccount.id } }), 0, 'ten provisional stamps do not issue a free-order reward');
  for (const pixOrder of rewardPixOrders) {
    const confirmation = await fetch(`${baseUrl}/api/admin/orders/${pixOrder.result.order.id}/proof-status`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'CONFIRMED' })
    });
    assert.equal(confirmation.status, 200);
  }
  assert.equal(await prisma.fidelityReward.count({ where: { accountId: rewardTestAccount.id } }), 0, 'payment confirmation alone does not issue the reward before order completion');
  for (const pixOrder of rewardPixOrders) await status(pixOrder.result.order.id, 'COMPLETED');
  rewardTestAccount = await prisma.fidelityAccount.findUnique({ where: { id: rewardTestAccount.id } });
  assert.equal(rewardTestAccount.validOrdersCount, 10);
  assert.equal(await prisma.fidelityReward.count({ where: { accountId: rewardTestAccount.id, status: 'AVAILABLE' } }), 1, 'the tenth confirmed and completed order issues one reward');

  const cancelled = await createOrder('84977776666', [[0, 1]]);
  await status(cancelled.result.order.id, 'CANCELLED');
  assert.equal(await prisma.fidelityAccount.findUnique({ where: { phoneNormalized: '84977776666' } }).then(item => item.points), 0, 'an uncompleted cancelled order earns no point');

  const pendingPixToken = 'ff9ffbe5-5ff8-4d6c-9046-bfaebea690e4';
  const pendingPixOrder = await createPixOrder('84977770003', [[0, 1]], pendingPixToken);
  assert.equal(pendingPixOrder.result.fidelity.provisionalPoints, 1);
  await stopServer();
  const restartedBaseUrl = await startServer();
  const persistedCardsResponse = await fetch(`${restartedBaseUrl}/api/admin/fidelity`, { headers: { Cookie: cookie } });
  assert.equal(persistedCardsResponse.status, 200, 'admin card history remains available after the server restarts');
  const persistedCard = (await persistedCardsResponse.json()).find(item => item.phoneNormalized === '84999999999');
  assert.equal(persistedCard.validOrdersCount, 12, 'server restart does not erase the loyalty history');
  assert.equal(persistedCard.rewards.length, 1);
  const persistedPixProgress = await fetch(`${restartedBaseUrl}/api/fidelity/progress?checkoutToken=${pixTokens[1]}`);
  assert.equal(persistedPixProgress.status, 200, 'provisional/confirmed Pix card access survives server restart');
  const restoredPixProgress = await persistedPixProgress.json();
  assert.equal(restoredPixProgress.points, 1);
  assert.equal(restoredPixProgress.provisionalPoints, 0);
  assert.equal(restoredPixProgress.validOrdersCount, 1);
  const persistedPendingPix = await fetch(`${restartedBaseUrl}/api/fidelity/progress?checkoutToken=${pendingPixToken}`);
  assert.equal(persistedPendingPix.status, 200, 'provisional credits remain persisted after server restart');
  const restoredPendingPix = await persistedPendingPix.json();
  assert.equal(restoredPendingPix.points, 1);
  assert.equal(restoredPendingPix.provisionalPoints, 1);
  assert.equal(restoredPendingPix.validOrdersCount, 0);

  console.log('Digital loyalty eligibility, per-order idempotency, rewards, cancellation review, phone normalization, and account separation passed.');
} finally {
  await stopServer();
  if (prisma) await prisma.$disconnect();
  await rm(temporaryRoot, { recursive: true, force: true });
}
