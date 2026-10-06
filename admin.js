const $ = selector => document.querySelector(selector);
const money = cents => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format((Number(cents || 0) / 100));
const labels = { RECEIVED: 'Recebido', PAYMENT_PENDING: 'Pagamento pendente', PAID: 'Pago', PREPARING: 'Em preparo', OUT_FOR_DELIVERY: 'Saiu para entrega', COMPLETED: 'Finalizado', CANCELLED: 'Cancelado' };
const proofLabels = { NONE: 'Sem comprovante', SENT: 'Comprovante enviado', CONFIRMED: 'Comprovante conferido', REJECTED: 'Comprovante recusado' };
let orders = [];
let currentCashPeriod = 'today';
let currentCashExpectedCents = 0;

async function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (!(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || 'Não foi possível concluir a operação.');
  return body;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function showAdmin() {
  $('[data-login]').hidden = true;
  $('[data-admin-content]').hidden = false;
  refresh();
  refreshCash();
}

function renderOrders() {
  $('[data-orders]').innerHTML = orders.length ? orders.map(order => {
    const proofStatus = order.pixProofStatus || 'NONE';
    const proofAction = order.pixProofUrl ? `<a class="mini-link" href="${order.pixProofUrl}" target="_blank" rel="noreferrer">Ver comprovante</a>` : '<span class="muted">Sem comprovante</span>';
    const actions = order.pixProofUrl ? `<div class="proof-actions"><button type="button" class="btn btn-secondary" data-proof-confirm="${order.id}">Confirmar pagamento</button><button type="button" class="btn btn-secondary" data-proof-reject="${order.id}">Recusar comprovante</button></div>` : '';
    return `<article class="admin-order"><div class="order-top"><div><strong>#${order.number}</strong><span>${new Date(order.createdAt).toLocaleString('pt-BR')}</span></div><select data-order-status="${order.id}">${Object.entries(labels).map(([value, label]) => `<option value="${value}" ${order.orderStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div><h3>${order.customerName}</h3><p>${order.phone} · ${order.deliveryMethod === 'DELIVERY' ? `${order.address}, ${order.addressNumber} - ${order.neighborhood}` : 'Retirada no local'}</p><ul>${order.items.map(item => `<li>${item.quantity}x ${item.productName} (${money(item.unitPriceCents)})</li>`).join('')}</ul><div class="order-total"><span>${order.paymentStatus === 'APPROVED' ? 'Pagamento aprovado' : 'Pagamento pendente'}</span><strong>${money(order.totalCents)}</strong></div><div class="proof-row"><span>${proofLabels[proofStatus] || proofLabels.NONE}</span>${proofAction}</div>${actions}</article>`;
  }).join('') : '<p>Nenhum pedido ainda.</p>';
}

async function refresh() {
  try {
    orders = await request('/api/admin/orders');
    renderOrders();
    renderProducts();
    const settings = await request('/api/admin/settings');
    $('[data-settings-form] input').value = settings.deliveryFeeCents;
  } catch (error) {
    $('[data-orders]').innerHTML = `<p class="form-message">${error.message}</p>`;
  }
}

async function renderProducts() {
  const products = await request('/api/admin/products');
  $('[data-products]').innerHTML = products.map(product => {
    const status = !product.active ? 'Inativo' : product.manualSoldOut ? 'Esgotado manualmente' : product.stock === 0 ? 'Esgotado · estoque zero' : `Disponível · ${product.stock} em estoque`;
    return `<article class="admin-product"><img src="${escapeHtml(product.imageUrl)}" alt="" /><div><strong>${escapeHtml(product.name)}</strong><span>${escapeHtml(product.category)} · ${money(product.priceCents)} · ${status}</span><span>${product.costCents != null ? `Custo: ${money(product.costCents)}` : 'Custo não informado'}</span></div><div class="admin-product-actions"><button class="btn btn-secondary" type="button" data-edit-product="${escapeHtml(product.id)}">Editar</button><button class="btn btn-secondary btn-danger" type="button" data-delete-product="${escapeHtml(product.id)}">Excluir</button></div></article>`;
  }).join('') || '<p>Nenhum produto cadastrado.</p>';
}

function updateCashDifference(expectedCents) {
  if (currentCashPeriod !== 'today') {
    $('[data-cash-difference]').textContent = 'Disponível no filtro Hoje';
    return;
  }
  const countedInput = $('[data-cash-counted]');
  $('[data-cash-difference]').textContent = countedInput.value === ''
    ? 'Informe o valor contado'
    : money(Math.round(Number(countedInput.value) * 100) - expectedCents);
}

async function refreshCash() {
  try {
    const url = currentCashPeriod === 'custom'
      ? `/api/admin/cash/summary?period=custom&from=${encodeURIComponent($('[data-cash-from]').value || '')}&to=${encodeURIComponent($('[data-cash-to]').value || '')}`
      : `/api/admin/cash/summary?period=${currentCashPeriod}`;
    const summary = await request(url);
    const history = await request(currentCashPeriod === 'custom'
      ? `/api/admin/cash/history?period=custom&from=${encodeURIComponent($('[data-cash-from]').value || '')}&to=${encodeURIComponent($('[data-cash-to]').value || '')}`
      : `/api/admin/cash/history?period=${currentCashPeriod}`);
    $('[data-cash-opening]').textContent = money(summary.openingBalanceCents);
    $('[data-cash-sales]').textContent = money(summary.totalSoldCents);
    $('[data-cash-cash]').textContent = money(summary.cashSalesCents);
    $('[data-cash-pix]').textContent = money(summary.pixCents);
    $('[data-cash-card]').textContent = money(summary.cardCents);
    $('[data-cash-entries]').textContent = money(summary.manualEntriesCents);
    $('[data-cash-outputs]').textContent = money(summary.manualOutputsCents);
    $('[data-cash-revenue]').textContent = money(summary.totalSoldCents);
    $('[data-cash-costs]').textContent = money(summary.costOfGoodsCents);
    $('[data-cash-cost-status]').textContent = summary.approvedOrdersCount === 0
      ? 'Sem vendas no período.'
      : summary.costUnavailableItemsCount
        ? `Custo ausente em ${summary.costUnavailableItemsCount} item(ns); valor parcial.`
        : 'Custos informados para todos os itens.';
    $('[data-cash-fees]').textContent = money(summary.feesCents);
    $('[data-cash-profit]').textContent = money(summary.profitCents);
    $('[data-cash-profit-label]').textContent = summary.profitIsPartial ? 'Lucro parcial' : 'Lucro';
    $('[data-cash-fee-status]').textContent = summary.approvedOrdersCount === 0
      ? 'Sem vendas no período.'
      : summary.feesUnavailableOrdersCount
        ? `Taxa não informada em ${summary.feesUnavailableOrdersCount} venda(s).`
        : 'Taxas reais informadas para todas as vendas.';
    $('[data-cash-expected]').textContent = money(summary.expectedCashCents);
    currentCashExpectedCents = summary.expectedCashCents;
    updateCashDifference(summary.expectedCashCents);
    const entries = [...(history.sales || []), ...(history.movements || [])].sort((left,right) => new Date(right.date) - new Date(left.date));
    $('[data-cash-history]').innerHTML = entries.length ? entries.map(item => {
      if (item.kind === 'sale') {
        const cost = item.custoDisponivel ? `custo ${money(item.custo)}` : 'custo indisponível';
        const fee = item.taxaDisponivel ? `taxa ${money(item.taxa)}` : 'taxa indisponível';
        const profit = item.lucroParcial ? `lucro parcial ${money(item.lucro)}` : `lucro ${money(item.lucro)}`;
        return `<div class="cash-history-item"><strong>#${item.pedido}</strong><span>${item.cliente} · ${item.formaPagamento}</span><small>${money(item.valor)} · ${cost} · ${fee} · ${profit}</small></div>`;
      }
      const label = item.kind === 'abertura' ? 'Abertura' : item.kind === 'entrada' ? 'Entrada' : 'Saída';
      return `<div class="cash-history-item"><strong>${label}</strong><span>${item.description || 'Movimentação'}</span><small>${money(item.valor)}</small></div>`;
    }).join('') : '<p>Nenhum registro no período.</p>';
    const closures = await request('/api/admin/cash/closures');
    $('[data-cash-closures]').innerHTML = closures.length ? closures.map(item => `<div class="closure-item"><strong>${new Date(item.closedAt).toLocaleDateString('pt-BR')}</strong><span>Esperado: ${money(item.closingBalanceCents)} · Contado: ${money(item.cashCents)} · Diferença: ${money(item.cashCents - item.closingBalanceCents)}</span></div>`).join('') : '<p>Nenhum fechamento salvo.</p>';
  } catch (error) {
    $('[data-cash-history]').innerHTML = `<p class="form-message">${error.message}</p>`;
  }
}

$('[data-login-form]').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await request('/api/admin/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    showAdmin();
  } catch (error) {
    $('[data-login-message]').textContent = error.message;
  }
});
$('[data-logout]').addEventListener('click', async () => { await request('/api/admin/logout', { method: 'POST' }); location.reload(); });
$('[data-refresh]').addEventListener('click', refresh);
$('[data-cash-refresh]').addEventListener('click', refreshCash);

document.addEventListener('change', async event => {
  if (!event.target.dataset.orderStatus) return;
  try {
    await request(`/api/admin/orders/${event.target.dataset.orderStatus}/status`, { method: 'PATCH', body: JSON.stringify({ status: event.target.value }) });
    await refresh();
  } catch (error) { alert(error.message); }
});

const productForm = $('[data-product-form]');
const productFileInput = $('[data-product-file]');
let productPreviewUrl = null;

function setProductPreview(source, name, isObjectUrl = false) {
  if (productPreviewUrl) URL.revokeObjectURL(productPreviewUrl);
  productPreviewUrl = isObjectUrl ? source : null;
  const preview = $('[data-product-preview]');
  preview.hidden = !source;
  $('[data-product-preview-image]').src = source || '';
  $('[data-product-image-name]').textContent = name || '';
}

function clearProductForm() {
  productForm.reset();
  productForm.elements.id.value = '';
  productFileInput.setCustomValidity('');
  setProductPreview('', '');
}

productFileInput.addEventListener('change', () => {
  const file = productFileInput.files?.[0];
  productFileInput.setCustomValidity('');
  if (!file) {
    setProductPreview('', '');
    return;
  }
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
    productFileInput.setCustomValidity('Selecione uma imagem JPG, PNG ou WEBP de até 5 MB.');
    productFileInput.reportValidity();
    productFileInput.value = '';
    setProductPreview('', '');
    return;
  }
  setProductPreview(URL.createObjectURL(file), `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`, true);
});

productForm.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const id = form.elements.id.value;
  data.delete('id');
  data.set('active', String(form.elements.active.checked));
  data.set('manualSoldOut', String(form.elements.manualSoldOut.checked));
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await request(id ? `/api/admin/products/${id}` : '/api/admin/products', { method: id ? 'PATCH' : 'POST', body: data });
    $('[data-product-message]').textContent = 'Produto salvo.';
    clearProductForm();
    await renderProducts();
  } catch (error) {
    $('[data-product-message]').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
$('[data-clear-product]').addEventListener('click', clearProductForm);
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-edit-product]');
  if (button) {
    try {
      const product = (await request('/api/admin/products')).find(item => item.id === button.dataset.editProduct);
      if (!product) throw new Error('Produto não encontrado.');
      clearProductForm();
      for (const [key, value] of Object.entries(product)) {
        const field = productForm.elements[key];
        if (field && field.type !== 'file') field.type === 'checkbox' ? field.checked = value : field.value = value;
      }
      setProductPreview(product.imageUrl, 'Foto atual');
      productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      $('[data-product-message]').textContent = error.message;
    }
    return;
  }

  const deleteButton = event.target.closest('[data-delete-product]');
  if (deleteButton) {
    const productId = deleteButton.dataset.deleteProduct;
    if (!confirm('Excluir este produto? Produtos que já aparecem em pedidos precisam ser desativados para preservar o histórico.')) return;
    try {
      await request(`/api/admin/products/${productId}`, { method: 'DELETE' });
      $('[data-product-message]').textContent = 'Produto excluído.';
      await renderProducts();
    } catch (error) {
      $('[data-product-message]').textContent = error.message;
    }
    return;
  }

  const confirmButton = event.target.closest('[data-proof-confirm]');
  if (confirmButton) {
    await request(`/api/admin/orders/${confirmButton.dataset.proofConfirm}/proof-status`, { method: 'PATCH', body: JSON.stringify({ status: 'CONFIRMED' }) });
    await refresh();
    await refreshCash();
    return;
  }

  const rejectButton = event.target.closest('[data-proof-reject]');
  if (rejectButton) {
    await request(`/api/admin/orders/${rejectButton.dataset.proofReject}/proof-status`, { method: 'PATCH', body: JSON.stringify({ status: 'REJECTED' }) });
    await refresh();
    await refreshCash();
  }
});
$('[data-settings-form]').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await request('/api/admin/settings', { method: 'PATCH', body: JSON.stringify({ deliveryFeeCents: Number(new FormData(event.currentTarget).get('deliveryFeeCents')) }) });
    $('[data-settings-message]').textContent = 'Taxa salva.';
  } catch (error) {
    $('[data-settings-message]').textContent = error.message;
  }
});

$('[data-cash-open-form]').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const payload = { openingBalanceCents: Math.round(Number(form.openingBalanceCents.value || 0) * 100) };
    await request('/api/admin/cash/open', { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    $('[data-cash-open-message]').textContent = 'Caixa aberto com sucesso.';
    await refreshCash();
  } catch (error) {
    $('[data-cash-open-message]').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('[data-cash-movement-form]').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  const payload = {
    type: form.type.value,
    amountCents: Math.round(Number(form.amountCents.value || 0) * 100),
    description: form.description.value.trim()
  };
  try {
    await request('/api/admin/cash/movements', { method: 'POST', body: JSON.stringify(payload) });
    form.reset();
    await refreshCash();
  } catch (error) {
    $('[data-cash-message]').textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$('[data-close-cash]').addEventListener('click', async () => {
  if (currentCashPeriod !== 'today') {
    $('[data-cash-close-message]').textContent = 'Selecione Hoje para fechar o caixa.';
    return;
  }
  const countedInput = $('[data-cash-counted]');
  if (countedInput.value === '') {
    $('[data-cash-close-message]').textContent = 'Informe o valor contado.';
    countedInput.focus();
    return;
  }
  const closeButton = $('[data-close-cash]');
  closeButton.disabled = true;
  try {
    const countedCash = Math.round(Number(countedInput.value) * 100);
    await request('/api/admin/cash/close', {
      method: 'POST',
      body: JSON.stringify({ cashCents: countedCash })
    });
    $('[data-cash-close-message]').textContent = 'Caixa fechado com sucesso.';
    await refreshCash();
  } catch (error) {
    $('[data-cash-close-message]').textContent = error.message;
  } finally {
    closeButton.disabled = false;
  }
});

$('[data-cash-counted]').addEventListener('input', () => {
  updateCashDifference(currentCashExpectedCents);
});

$('[data-custom-period]').addEventListener('click', async () => {
  if (!$('[data-cash-from]').value || !$('[data-cash-to]').value) {
    alert('Informe as datas inicial e final para aplicar o período personalizado.');
    return;
  }
  currentCashPeriod = 'custom';
  document.querySelectorAll('[data-period]').forEach(item => item.classList.toggle('is-active', false));
  await refreshCash();
});

document.querySelectorAll('[data-period]').forEach(button => {
  button.addEventListener('click', async () => {
    currentCashPeriod = button.dataset.period;
    document.querySelectorAll('[data-period]').forEach(item => item.classList.toggle('is-active', item === button));
    await refreshCash();
  });
});

request('/api/admin/me').then(showAdmin).catch(() => { $('[data-login]').hidden = false; });
setInterval(() => { if (!$('[data-admin-content]').hidden) { refresh(); refreshCash(); } }, 15000);
