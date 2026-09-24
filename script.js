const state = { products: [], cart: new Map(), deliveryFee: 0 };
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
const $ = selector => document.querySelector(selector);
const apiBase = window.CANTINHO_API_BASE || '';

async function apiFetch(path, options) {
	try {
		return await fetch(`${apiBase}${path}`, options);
	} catch {
		throw new Error('A API do sistema está offline. Inicie o backend e abra o site pelo endereço publicado.');
	}
}

document.getElementById('year').textContent = new Date().getFullYear();

async function loadCatalog() {
	const [productsResponse, settingsResponse] = await Promise.all([apiFetch('/api/products'), apiFetch('/api/settings')]);
	if (!productsResponse.ok || !settingsResponse.ok) throw new Error('Não foi possível carregar o cardápio.');
	state.products = await productsResponse.json();
	state.deliveryFee = (await settingsResponse.json()).deliveryFee;
	const aliases = { 'creme-de-frango': 'Creme de Frango', panqueca: 'Panqueca', strogonoff: 'Strogonoff', lasanha: 'Lasanha', 'escondidinho-de-carne': 'Escondidinho de Carne' };
	for (const [slug, name] of Object.entries(aliases)) {
		const product = state.products.find(item => item.name === name);
		const card = document.querySelector(`.menu-card[data-product-id="${slug}"]`);
		if (!product && card) { card.hidden = true; continue; }
		if (card) {
			card.dataset.productId = product.id;
			card.querySelector('.menu-header span').textContent = money(product.price);
			card.querySelector('.add-to-cart').dataset.productId = product.id;
		}
	}
}

function cartItems() { return [...state.cart.entries()].map(([productId, quantity]) => ({ product: state.products.find(item => item.id === productId), quantity })).filter(item => item.product); }
function normalizeNeighborhood(value) { return String(value || '').trim().toLocaleLowerCase('pt-BR'); }
function calculateDeliveryFee(neighborhood, deliveryMethod) {
	if (deliveryMethod === 'PICKUP') return 0;
	return ['upanema', 'ipanema'].includes(normalizeNeighborhood(neighborhood)) ? 5 : 2;
}
function totals() {
	const subtotal = cartItems().reduce((total, item) => total + item.product.price * item.quantity, 0);
	const deliveryMethod = document.querySelector('input[name="deliveryMethod"]:checked')?.value;
	const neighborhood = document.querySelector('input[name="neighborhood"]')?.value;
	const delivery = calculateDeliveryFee(neighborhood, deliveryMethod);
	return { subtotal, delivery, total: subtotal + delivery };
}
function renderCart() {
	const items = cartItems();
	$('[data-cart-count]').textContent = items.reduce((total, item) => total + item.quantity, 0);
	$('[data-cart-items]').innerHTML = items.length ? items.map(({ product, quantity }) => `<div class="cart-item"><div><strong>${product.name}</strong><span>${money(product.price)} cada</span></div><div class="quantity"><button type="button" data-decrease="${product.id}">-</button><b>${quantity}</b><button type="button" data-increase="${product.id}">+</button><button class="remove" type="button" data-remove="${product.id}" aria-label="Remover ${product.name}">&times;</button></div></div>`).join('') : '<p class="empty-cart">Seu carrinho está vazio.</p>';
	const summary = totals();
	$('[data-cart-subtotal]').textContent = money(summary.subtotal);
	$('[data-cart-delivery]').textContent = money(summary.delivery);
	$('[data-cart-total]').textContent = money(summary.total);
	$('[data-checkout-items]').innerHTML = items.map(({ product, quantity }) => `<p><span>${quantity}x ${product.name}</span><strong>${money(product.price * quantity)}</strong></p>`).join('') || '<p>Nenhum item adicionado.</p>';
	$('[data-checkout-subtotal]').textContent = money(summary.subtotal);
	$('[data-checkout-delivery]').textContent = money(summary.delivery);
	$('[data-checkout-total]').textContent = money(summary.total);
}
function changeCart(productId, delta) { const next = (state.cart.get(productId) || 0) + delta; next > 0 ? state.cart.set(productId, next) : state.cart.delete(productId); renderCart(); }
function openCart() { $('[data-cart-panel]').classList.add('is-open'); $('.overlay').classList.add('is-visible'); $('[data-cart-panel]').setAttribute('aria-hidden', 'false'); }
function closeCart() { $('[data-cart-panel]').classList.remove('is-open'); $('.overlay').classList.remove('is-visible'); $('[data-cart-panel]').setAttribute('aria-hidden', 'true'); }
async function pollPaymentStatus(orderId) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		await new Promise(resolve => setTimeout(resolve, 5000));
		try {
			const response = await apiFetch(`/api/orders/${encodeURIComponent(orderId)}/payment-status`);
			if (!response.ok) continue;
			const status = await response.json();
			const statusElement = $('[data-payment-status]');
			if (!statusElement) return;
			if (status.paymentStatus === 'APPROVED') { statusElement.textContent = 'Pagamento confirmado'; return; }
			if (status.paymentStatus === 'REJECTED' || status.orderStatus === 'CANCELLED') { statusElement.textContent = 'Pagamento recusado ou cancelado'; return; }
			statusElement.textContent = 'Aguardando pagamento';
		} catch { }
	}
}
document.addEventListener('click', event => {
	const add = event.target.closest('.add-to-cart');
	if (add?.dataset.productId) { changeCart(add.dataset.productId, 1); openCart(); }
	if (event.target.closest('[data-open-cart]')) openCart();
	if (event.target.closest('[data-close-cart]')) closeCart();
	const increase = event.target.closest('[data-increase]'); if (increase) changeCart(increase.dataset.increase, 1);
	const decrease = event.target.closest('[data-decrease]'); if (decrease) changeCart(decrease.dataset.decrease, -1);
	const remove = event.target.closest('[data-remove]'); if (remove) { state.cart.delete(remove.dataset.remove); renderCart(); }
	if (event.target.closest('[data-open-checkout]') && state.cart.size) { closeCart(); $('[data-checkout-dialog]').showModal(); renderCart(); }
	if (event.target.closest('[data-close-checkout]')) $('[data-checkout-dialog]').close();
});
document.addEventListener('input', event => { if (event.target.name === 'neighborhood') renderCart(); });
document.addEventListener('change', event => { if (event.target.name === 'deliveryMethod') { $('[data-address-fields]').hidden = event.target.value === 'PICKUP'; renderCart(); } });

$('[data-checkout-form]').addEventListener('submit', async event => {
	event.preventDefault();
	const form = event.currentTarget;
	const message = $('[data-form-message]');
	const data = Object.fromEntries(new FormData(form));
	data.items = cartItems().map(({ product, quantity }) => ({ productId: product.id, quantity: Number(quantity) }));
	message.textContent = 'Criando seu pedido...';
	form.querySelector('button[type="submit"]').disabled = true;
	try {
		const response = await apiFetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
		const result = await response.json();
		if (!response.ok) throw new Error(result.error || 'Confira os dados informados.');
		state.cart.clear(); renderCart(); form.reset(); $('[data-address-fields]').hidden = false;
		message.textContent = 'Pedido realizado com sucesso!';
		const payment = $('[data-payment-result]');
		if (result.payment?.type === 'PIX' && result.payment.qr_code_base64 && result.payment.qr_code) {
			const ticketLink = result.payment.ticket_url ? `<a class="btn btn-secondary" href="${result.payment.ticket_url}" target="_blank" rel="noreferrer">ABRIR PAGAMENTO PIX</a>` : '';
			payment.innerHTML = `<h4>Pagamento Pix</h4><p class="notice" data-payment-status>Aguardando pagamento</p><img class="pix-qr" src="data:image/jpeg;base64,${result.payment.qr_code_base64}" alt="QR Code Pix" /><p>Valor: <strong>${money(result.payment.amount ?? result.order.total)}</strong></p><label>Código Pix Copia e Cola<textarea readonly data-pix-code>${result.payment.qr_code}</textarea></label><button class="btn btn-secondary" type="button" data-copy-pix>Copiar Pix Copia e Cola</button>${ticketLink}<p>O pedido será encaminhado à marmitaria após a confirmação do pagamento.</p>`;
			pollPaymentStatus(result.order.id);
		}
		else if (result.payment?.type === 'CARD' && result.payment.checkoutUrl) payment.innerHTML = `<h4>Pagamento seguro</h4><p>Você será direcionado ao checkout do Mercado Pago.</p><a class="btn btn-primary" href="${result.payment.checkoutUrl}">Pagar com cartão</a><p>O pedido será encaminhado à marmitaria após a confirmação do pagamento.</p>`;
		else payment.innerHTML = '<p class="notice">O pedido foi registrado, mas o gateway ainda não está configurado no servidor.</p>';
	} catch (error) { message.textContent = error.message; }
	finally { form.querySelector('button[type="submit"]').disabled = false; }
});

document.addEventListener('click', async event => {
	if (!event.target.closest('[data-copy-pix]')) return;
	const code = $('[data-pix-code]')?.value;
	if (!code) return;
	await navigator.clipboard.writeText(code);
	event.target.closest('[data-copy-pix]').textContent = 'Pix copiado';
});

loadCatalog().then(renderCart).catch(error => { $('[data-form-message]').textContent = error.message; });
