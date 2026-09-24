const currency = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function money(cents) {
  return currency.format(Number(cents || 0) / 100).replace(/\u00a0/g, ' ');
}

export function normalizeWhatsAppNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

export function formatWhatsAppOrderMessage(order) {
  const items = (order.items || []).map(item => `- ${item.productName} x${item.quantity} — ${money(item.unitPriceCents * item.quantity)}`).join('\n');
  const paymentMethod = order.paymentMethod === 'CARD' ? 'CARTAO' : order.paymentMethod || 'Nao informado';
  const deliveryMethod = order.deliveryMethod === 'PICKUP' ? 'Retirada no local' : 'Entrega';
  const paymentStatus = order.paymentStatus === 'APPROVED' || order.orderStatus === 'PAID' ? 'PAGAMENTO APROVADO' : order.paymentStatus || 'PENDENTE';

  return [
    '🍱 NOVO PEDIDO — CANTINHO POTIGUAR',
    '',
    `Numero do pedido: ${order.id}`,
    '',
    'CLIENTE',
    `Nome: ${order.customerName}`,
    `Telefone: ${order.phone}`,
    '',
    'ENTREGA',
    `Modalidade: ${deliveryMethod}`,
    `Endereco: ${order.address || '-'}`,
    `Numero: ${order.addressNumber || '-'}`,
    `Bairro: ${order.neighborhood || '-'}`,
    `Complemento: ${order.complement || '-'}`,
    `Ponto de referencia: ${order.reference || '-'}`,
    '',
    'PEDIDO',
    items || '- Nenhum item informado',
    '',
    'VALORES',
    `Subtotal: ${money(order.subtotalCents)}`,
    `Taxa de entrega: ${money(order.deliveryFeeCents)}`,
    `TOTAL: ${money(order.totalCents)}`,
    '',
    'PAGAMENTO',
    `Forma de pagamento: ${paymentMethod}`,
    `Status: ${paymentStatus}`
  ].join('\n');
}

export function buildWhatsAppUrl(order, destination) {
  const number = normalizeWhatsAppNumber(destination);
  if (!number) return null;
  return `https://wa.me/${number}?text=${encodeURIComponent(formatWhatsAppOrderMessage(order))}`;
}

export function getWhatsAppConfig(env = process.env) {
  return {
    accessToken: env.WHATSAPP_ACCESS_TOKEN?.trim(),
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID?.trim(),
    graphApiVersion: env.WHATSAPP_GRAPH_API_VERSION?.trim(),
    templateName: env.WHATSAPP_TEMPLATE_NAME?.trim(),
    templateLanguage: env.WHATSAPP_TEMPLATE_LANGUAGE?.trim() || 'pt_BR',
    destination: normalizeWhatsAppNumber(env.ADMIN_WHATSAPP)
  };
}

export async function sendOrderToWhatsApp(order, env = process.env) {
  const config = getWhatsAppConfig(env);
  const missing = ['accessToken', 'phoneNumberId', 'graphApiVersion', 'templateName', 'destination'].filter(key => !config[key]);
  if (missing.length) throw new Error(`WhatsApp Cloud API nao configurada. Variaveis ausentes: ${missing.join(', ')}.`);

  const response = await fetch(`https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: config.destination,
      type: 'template',
      template: {
        name: config.templateName,
        language: { code: config.templateLanguage },
        components: [{ type: 'body', parameters: [{ type: 'text', text: formatWhatsAppOrderMessage(order) }] }]
      }
    })
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(responseBody.error?.message || responseBody.error || 'WhatsApp Cloud API recusou o envio.');
    error.status = response.status;
    throw error;
  }
  return { messageId: responseBody.messages?.[0]?.id || null };
}
