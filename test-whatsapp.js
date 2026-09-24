import assert from 'node:assert/strict';
import { buildWhatsAppUrl, formatWhatsAppOrderMessage, normalizeWhatsAppNumber } from './whatsapp.js';

const order = {
  id: 'pedido-teste',
  customerName: 'Cliente Teste',
  phone: '84999999999',
  deliveryMethod: 'DELIVERY',
  address: 'Rua de Teste',
  addressNumber: '10',
  neighborhood: 'Upanema',
  complement: 'Casa',
  reference: 'Portao azul',
  items: [{ productName: 'Marmita', quantity: 2, unitPriceCents: 1500 }],
  subtotalCents: 3000,
  deliveryFeeCents: 500,
  totalCents: 3500,
  paymentMethod: 'PIX',
  paymentStatus: 'APPROVED',
  orderStatus: 'PAYMENT_PENDING'
};

const message = formatWhatsAppOrderMessage(order);
const url = buildWhatsAppUrl(order, '55 (84) 98115-276');

assert.equal(normalizeWhatsAppNumber('55 (84) 98115-276'), '558498115276');
assert.match(message, /Numero do pedido: pedido-teste/);
assert.match(message, /Nome: Cliente Teste/);
assert.match(message, /Marmita x2/);
assert.match(message, /Taxa de entrega: R\$ 5,00/);
assert.match(message, /TOTAL: R\$ 35,00/);
assert.match(message, /Status: PAGAMENTO APROVADO/);
assert.match(message, /Forma de pagamento: PIX/);
assert.ok(url.startsWith('https://wa.me/558498115276?text='));
assert.equal(buildWhatsAppUrl(order, 'abc'), null);

console.log('WhatsApp order message: OK');