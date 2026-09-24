import 'dotenv/config';
import crypto from 'node:crypto';

const token = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
const apiUrl = 'https://api.mercadopago.com';
const externalReference = `teste-pix-cantinho-potiguar-${crypto.randomUUID()}`;
const requestBody = {
  type: 'online',
  total_amount: '50.00',
  external_reference: externalReference,
  payer: {
    email: 'test_user_br@testuser.com',
    first_name: 'APRO'
  },
  transactions: {
    payments: [
      {
        amount: '50.00',
        payment_method: {
          id: 'pix',
          type: 'bank_transfer'
        }
      }
    ]
  }
};

function getPayment(order) {
  return order.transactions?.payments?.[0]
    || order.transaction?.payments?.[0]
    || order.payments?.[0]
    || null;
}
function isApproved(order, payment) {
  return ['approved', 'processed', 'completed'].includes(String(order.status || '').toLowerCase())
    || ['approved', 'processed', 'completed'].includes(String(payment?.status || '').toLowerCase());
}
function printPoll(order) {
  const payment = getPayment(order);
  console.log(`[${new Date().toISOString()}] Order status: ${order.status || ''}`);
  console.log(`[${new Date().toISOString()}] Order status_detail: ${order.status_detail || ''}`);
  console.log(`[${new Date().toISOString()}] Payment status: ${payment?.status || ''}`);
  console.log(`[${new Date().toISOString()}] Payment status_detail: ${payment?.status_detail || ''}`);
  return payment;
}
function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function main() {
  console.log(`Access Token configurado: ${Boolean(token)}`);
  if (!token) {
    console.log('TESTE FINALIZADO SEM APROVAÇÃO AUTOMÁTICA');
    process.exitCode = 1;
    return;
  }

  const creationResponse = await fetch(`${apiUrl}/v1/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': crypto.randomUUID()
    },
    body: JSON.stringify(requestBody)
  });
  const createdOrder = await creationResponse.json().catch(() => ({}));
  const createdPayment = getPayment(createdOrder);
  console.log(`HTTP status da criação: ${creationResponse.status}`);
  console.log(`Order ID: ${createdOrder.id || ''}`);
  console.log(`Payment ID: ${createdPayment?.id || ''}`);
  console.log(`Status inicial: ${createdOrder.status || ''}`);
  console.log(`Status detail inicial: ${createdOrder.status_detail || ''}`);

  if (!creationResponse.ok || !createdOrder.id) {
    console.log('TESTE FINALIZADO SEM APROVAÇÃO AUTOMÁTICA');
    process.exitCode = 1;
    return;
  }

  for (let attempt = 0; attempt < 13; attempt += 1) {
    if (attempt > 0) await wait(5000);
    const statusResponse = await fetch(`${apiUrl}/v1/orders/${encodeURIComponent(createdOrder.id)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const currentOrder = await statusResponse.json().catch(() => ({}));
    const payment = printPoll(currentOrder);
    if (statusResponse.ok && isApproved(currentOrder, payment)) {
      console.log('TESTE DE PAGAMENTO APROVADO');
      return;
    }
  }

  console.log('TESTE FINALIZADO SEM APROVAÇÃO AUTOMÁTICA');
}

main().catch(() => {
  console.log('TESTE FINALIZADO SEM APROVAÇÃO AUTOMÁTICA');
  process.exitCode = 1;
});
