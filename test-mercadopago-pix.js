import 'dotenv/config';
import crypto from 'node:crypto';

const token = process.env.MERCADOPAGO_ACCESS_TOKEN?.trim();
const apiUrl = 'https://api.mercadopago.com';
const requestBody = {
  type: 'online',
  external_reference: 'teste-pix-cantinho-potiguar',
  total_amount: '50.00',
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
function printCreationResult(status, order) {
  const payment = getPayment(order);
  const paymentMethod = payment?.payment_method || {};
  console.log(`HTTP status: ${status}`);
  console.log(`Order ID: ${order.id || ''}`);
  console.log(`Payment ID: ${payment?.id || ''}`);
  console.log(`Order status: ${order.status || ''}`);
  console.log(`Payment status: ${payment?.status || ''}`);
  console.log(`QR Code recebido: ${Boolean(paymentMethod.qr_code_base64)}`);
  console.log(`Pix Copia e Cola recebido: ${Boolean(paymentMethod.qr_code)}`);
  console.log(`Ticket URL recebido: ${Boolean(paymentMethod.ticket_url)}`);
}

async function main() {
  console.log(`Access Token configurado: ${Boolean(token)}`);
  if (!token) process.exitCode = 1;
  if (!token) return;

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
  printCreationResult(creationResponse.status, createdOrder);

  const orderId = createdOrder.id;
  if (!orderId) {
    console.log('Status final da Order:');
    console.log('Status final do pagamento:');
    process.exitCode = 1;
    return;
  }

  const statusResponse = await fetch(`${apiUrl}/v1/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const finalOrder = await statusResponse.json().catch(() => ({}));
  const finalPayment = getPayment(finalOrder);
  console.log(`Status final da Order: ${finalOrder.status || ''}`);
  console.log(`Status final do pagamento: ${finalPayment?.status || ''}`);
  if (!statusResponse.ok) process.exitCode = 1;
}

main().catch(() => {
  process.exitCode = 1;
});
