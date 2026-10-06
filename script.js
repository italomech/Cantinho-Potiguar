const state = { products: [], cart: new Map(), deliveryFee: 0, pixPayment: null };
function parsePrice(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	const normalized = String(value ?? '').trim().replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
	const price = Number(normalized);
	return Number.isFinite(price) ? price : 0;
}
const money = value => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(parsePrice(value));
const $ = selector => document.querySelector(selector);
const apiBase = window.CANTINHO_API_BASE || '';
const orderWhatsAppNumber = '558498115276';
const mobileMenuToggle = $('[data-mobile-menu-toggle]');
const mainMenu = $('[data-main-menu]');
const productGrid = $('[data-menu-products]');
const staticMenuCards = [...productGrid.querySelectorAll('.menu-card:not([data-product-id])')].map(card => card.outerHTML).join('');

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function productIsAvailable(product) {
	return product.active !== false && !product.manualSoldOut && Number(product.stock) > 0;
}

function renderMenu() {
	productGrid.innerHTML = state.products.map(product => {
		const available = productIsAvailable(product);
		const stockLabel = available ? `${product.stock} em estoque` : 'ESGOTADO';
		return `<article class="menu-card${available ? '' : ' is-sold-out'}" data-product-id="${escapeHtml(product.id)}">
			<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" />
			<div class="menu-body">
				<div class="menu-header"><h3>${escapeHtml(product.name)}</h3><span>${money(product.price)}</span></div>
				<p>${escapeHtml(product.description)}</p>
				<span class="menu-stock${available ? '' : ' is-sold-out'}">${stockLabel}</span>
				<button class="btn btn-primary add-to-cart" type="button" data-product-id="${escapeHtml(product.id)}"${available ? '' : ' disabled'}>${available ? 'Adicionar' : 'Esgotado'}</button>
			</div>
		</article>`;
	}).join('') + staticMenuCards;
}

function setMobileMenuOpen(isOpen) {
	mainMenu.classList.toggle('is-open', isOpen);
	mobileMenuToggle.setAttribute('aria-expanded', String(isOpen));
	mobileMenuToggle.setAttribute('aria-label', isOpen ? 'Fechar menu' : 'Abrir menu');
}

mobileMenuToggle.addEventListener('click', () => {
	setMobileMenuOpen(mobileMenuToggle.getAttribute('aria-expanded') !== 'true');
});
mainMenu.addEventListener('click', event => {
	if (event.target.closest('a')) setMobileMenuOpen(false);
});
document.addEventListener('keydown', event => {
	if (event.key === 'Escape') setMobileMenuOpen(false);
});

async function apiFetch(path, options) {
	try {
		return await fetch(`${apiBase}${path}`, options);
	} catch {
		throw new Error('A API do sistema está offline. Inicie o backend e abra o site pelo endereço publicado.');
	}
}

document.getElementById('year').textContent = new Date().getFullYear();

async function loadCatalog() {
	const productsResponse = await apiFetch('/api/products');
	if (!productsResponse.ok) throw new Error('Não foi possível carregar o cardápio.');
	state.products = (await productsResponse.json()).map(product => ({ ...product, id: String(product.id), price: parsePrice(product.price ?? Number(product.priceCents) / 100) }));
	renderMenu();
	renderCart();
}

async function loadPixSettings() {
	try {
		const response = await apiFetch('/api/settings');
		if (!response.ok) throw new Error('Não foi possível carregar os dados do Pix.');
		const settings = await response.json();
		state.deliveryFee = settings.deliveryFee;
		state.pixPayment = settings.pix;
		renderPixPayment();
		renderCart();
	} catch (error) {
		state.pixPayment = null;
		renderPixPayment();
		$('[data-pix-config-message]').textContent = 'Não foi possível carregar os dados do Pix. Atualize a página ou tente novamente.';
		$('[data-form-message]').textContent = error.message;
	}
}

function cartItems() { return [...state.cart.entries()].map(([productId, quantity]) => ({ product: state.products.find(item => String(item.id) === String(productId)), quantity })).filter(item => item.product); }
function normalizeNeighborhood(value) { return String(value || '').trim().toLocaleLowerCase('pt-BR'); }
function normalizeBlockedNeighborhood(value) {
	return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]/g, '');
}
function isOneEditAway(left, right) {
	if (Math.abs(left.length - right.length) > 1) return false;
	let leftIndex = 0;
	let rightIndex = 0;
	let edits = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		if (left[leftIndex] === right[rightIndex]) {
			leftIndex += 1;
			rightIndex += 1;
			continue;
		}
		edits += 1;
		if (edits > 1) return false;
		if (left.length === right.length && left[leftIndex + 1] === right[rightIndex] && left[leftIndex] === right[rightIndex + 1]) {
			leftIndex += 2;
			rightIndex += 2;
		} else if (left.length > right.length) leftIndex += 1;
		else if (right.length > left.length) rightIndex += 1;
		else {
			leftIndex += 1;
			rightIndex += 1;
		}
	}
	return edits + (leftIndex < left.length || rightIndex < right.length ? 1 : 0) <= 1;
}
function isUnavailableNeighborhood(value) {
	const normalized = normalizeBlockedNeighborhood(value);
	return ['instabul', 'vertentes'].some(neighborhood => isOneEditAway(normalized, neighborhood));
}
function updateNeighborhoodValidation() {
	const method = document.querySelector('input[name="deliveryMethod"]:checked')?.value;
	const neighborhood = document.querySelector('input[name="neighborhood"]')?.value;
	const blocked = method === 'DELIVERY' && isUnavailableNeighborhood(neighborhood);
	const warning = $('[data-neighborhood-message]');
	warning.hidden = !blocked;
	updateSendOrderButton();
	return blocked;
}
function calculateDeliveryFee(neighborhood, deliveryMethod) {
	if (deliveryMethod === 'PICKUP') return 0;
	return ['upanema', 'ipanema'].includes(normalizeNeighborhood(neighborhood)) ? 5 : 2;
}
function totals() {
	const subtotal = cartItems().reduce((total, item) => total + parsePrice(item.product.price) * Number(item.quantity), 0);
	const deliveryMethod = document.querySelector('input[name="deliveryMethod"]:checked')?.value;
	const neighborhood = document.querySelector('input[name="neighborhood"]')?.value;
	const delivery = calculateDeliveryFee(neighborhood, deliveryMethod);
	return { subtotal, delivery, total: subtotal + delivery };
}
function renderCart() {
	const items = cartItems();
	$('[data-cart-count]').textContent = items.reduce((total, item) => total + item.quantity, 0);
	$('[data-cart-items]').innerHTML = items.length ? items.map(({ product, quantity }) => `<div class="cart-item"><div><strong>${escapeHtml(product.name)}</strong><span>${money(product.price)} cada · ${product.stock} em estoque</span></div><div class="quantity"><button type="button" data-decrease="${escapeHtml(product.id)}" aria-label="Diminuir quantidade de ${escapeHtml(product.name)}">-</button><b>${quantity}</b><button type="button" data-increase="${escapeHtml(product.id)}" aria-label="Aumentar quantidade de ${escapeHtml(product.name)}"${!productIsAvailable(product) || quantity >= product.stock ? ' disabled' : ''}>+</button><button class="remove" type="button" data-remove="${escapeHtml(product.id)}" aria-label="Remover ${escapeHtml(product.name)}">&times;</button></div></div>`).join('') : '<p class="empty-cart">Seu carrinho está vazio.</p>';
	const summary = totals();
	$('[data-cart-subtotal]').textContent = money(summary.subtotal);
	$('[data-cart-delivery]').textContent = money(summary.delivery);
	$('[data-cart-total]').textContent = money(summary.total);
	$('[data-checkout-items]').innerHTML = items.map(({ product, quantity }) => `<p><span>${quantity}x ${product.name}</span><strong>${money(product.price * quantity)}</strong></p>`).join('') || '<p>Nenhum item adicionado.</p>';
	$('[data-checkout-subtotal]').textContent = money(summary.subtotal);
	$('[data-checkout-delivery]').textContent = money(summary.delivery);
	$('[data-checkout-total]').textContent = money(summary.total);
	updateNeighborhoodValidation();
}
function changeCart(productId, delta) {
	const normalizedProductId = String(productId);
	const product = state.products.find(item => String(item.id) === normalizedProductId);
	if (!product) return false;
	const next = (state.cart.get(normalizedProductId) || 0) + delta;
	if (delta > 0 && (!productIsAvailable(product) || next > product.stock)) {
		$('[data-form-message]').textContent = product.manualSoldOut || product.stock === 0 ? 'Este produto está esgotado.' : `Estoque disponível: ${product.stock} unidade(s).`;
		return false;
	}
	if (next > 0) state.cart.set(normalizedProductId, next);
	else state.cart.delete(normalizedProductId);
	renderCart();
	return true;
}
function openCart() { $('[data-cart-panel]').classList.add('is-open'); $('.overlay').classList.add('is-visible'); $('[data-cart-panel]').setAttribute('aria-hidden', 'false'); }
function closeCart() { $('[data-cart-panel]').classList.remove('is-open'); $('.overlay').classList.remove('is-visible'); $('[data-cart-panel]').setAttribute('aria-hidden', 'true'); }

function renderPixPayment() {
	const configured = Boolean(state.pixPayment?.configured);
	const qrConfigured = configured && Boolean(state.pixPayment?.qrConfigured && state.pixPayment?.qrCodeDataUrl);
	const qr = $('[data-pix-qr]');
	const key = $('[data-pix-key]');
	const keyLine = key.closest('.pix-key-line');
	const message = $('[data-pix-config-message]');
	qr.hidden = !qrConfigured;
	qr.src = qrConfigured ? state.pixPayment.qrCodeDataUrl : '';
	key.textContent = configured ? state.pixPayment.pixKey : '';
	keyLine.hidden = !configured;
	message.textContent = !configured
		? 'Pagamento Pix indisponível no momento. Configure a chave Pix no servidor.'
		: qrConfigured ? '' : 'A chave Pix está pronta para copiar. O QR Code será exibido após configurar um BR Code compatível com esta chave.';
	$('[data-copy-pix-key]').disabled = !configured;
	updateSendOrderButton();
}
document.addEventListener('click', event => {
	const add = event.target.closest('.add-to-cart');
	if (add?.dataset.productId && changeCart(add.dataset.productId, 1)) openCart();
	if (event.target.closest('[data-open-cart]')) openCart();
	if (event.target.closest('[data-close-cart]')) closeCart();
	const increase = event.target.closest('[data-increase]'); if (increase) changeCart(increase.dataset.increase, 1);
	const decrease = event.target.closest('[data-decrease]'); if (decrease) changeCart(decrease.dataset.decrease, -1);
	const remove = event.target.closest('[data-remove]'); if (remove) { state.cart.delete(remove.dataset.remove); renderCart(); }
	if (event.target.closest('[data-open-checkout]') && state.cart.size) { closeCart(); $('[data-checkout-dialog]').showModal(); renderCart(); }
	if (event.target.closest('[data-close-checkout]')) $('[data-checkout-dialog]').close();
});
document.addEventListener('input', event => { if (event.target.name === 'neighborhood') renderCart(); });
document.addEventListener('change', event => {
	if (event.target.name === 'deliveryMethod') { $('[data-address-fields]').hidden = event.target.value === 'PICKUP'; renderCart(); }
});

const proofInput = $('[data-checkout-form] input[name="pixProof"]');
const proofStatus = $('[data-pix-proof-status]');
const proofPreview = $('[data-pix-proof-preview]');
const proofImage = $('[data-pix-proof-image]');
const proofName = $('[data-pix-proof-name]');
const sendOrderButton = $('[data-send-order]');
const maxProofSize = 10 * 1024 * 1024;
const proofMimeByExtension = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };
let proofPreviewUrl = null;
let orderCreated = false;
let orderShared = false;
let createdOrderMessage = '';

function isSupportedProof(file) {
	const extension = file.name.match(/\.[^.]+$/)?.[0].toLowerCase();
	const expectedMime = proofMimeByExtension[extension];
	return Boolean(expectedMime && (!file.type || file.type === expectedMime || file.type === 'application/octet-stream'));
}

function updateSendOrderButton() {
	const file = proofInput.files?.[0];
	const method = document.querySelector('input[name="deliveryMethod"]:checked')?.value;
	const neighborhood = document.querySelector('input[name="neighborhood"]')?.value;
	const blockedNeighborhood = method === 'DELIVERY' && isUnavailableNeighborhood(neighborhood);
	const unavailableProduct = cartItems().some(({ product, quantity }) => !productIsAvailable(product) || quantity > product.stock);
	sendOrderButton.disabled = orderShared || (!orderCreated && (!state.pixPayment?.configured || !file || file.size > maxProofSize || !isSupportedProof(file) || blockedNeighborhood || unavailableProduct));
}

function clearProofPreview() {
	if (proofPreviewUrl) URL.revokeObjectURL(proofPreviewUrl);
	proofPreviewUrl = null;
	proofPreview.hidden = true;
	proofImage.hidden = true;
	proofImage.removeAttribute('src');
	proofName.textContent = '';
}

proofInput.addEventListener('change', () => {
	const file = proofInput.files?.[0];
	clearProofPreview();
	if (!file) {
		proofStatus.textContent = 'Selecione um arquivo de até 10 MB.';
		proofStatus.classList.remove('is-error');
		updateSendOrderButton();
		return;
	}
	if (file.size === 0) {
		proofInput.value = '';
		proofStatus.textContent = 'O arquivo está vazio. Selecione outro comprovante.';
		proofStatus.classList.add('is-error');
		updateSendOrderButton();
		return;
	}
	if (file.size > maxProofSize) {
		proofInput.value = '';
		proofStatus.textContent = 'O arquivo excede o limite de 10 MB. Selecione um arquivo menor.';
		proofStatus.classList.add('is-error');
		updateSendOrderButton();
		return;
	}
	if (!isSupportedProof(file)) {
		proofInput.value = '';
		proofStatus.textContent = 'Formato não aceito. Selecione JPG, JPEG, PNG, WEBP ou PDF.';
		proofStatus.classList.add('is-error');
		updateSendOrderButton();
		return;
	}
	proofName.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
	proofPreview.hidden = false;
	const fileExtension = file.name.match(/\.[^.]+$/)?.[0].toLowerCase();
	if (proofMimeByExtension[fileExtension]?.startsWith('image/')) {
		proofPreviewUrl = URL.createObjectURL(file);
		proofImage.src = proofPreviewUrl;
		proofImage.hidden = false;
	}
	proofStatus.textContent = 'Comprovante selecionado.';
	proofStatus.classList.remove('is-error');
	updateSendOrderButton();
});

function formatCustomerOrderMessage(order) {
	const proofUrl = order.pixProofUrl ? new URL(order.pixProofUrl, window.location.origin).href : null;
	const lines = [
		'🍱 NOVO PEDIDO — CANTINHO POTIGUAR',
		'',
		`Cliente: ${order.customerName}`,
		`Telefone: ${order.phone}`
	];
	if (order.deliveryMethod === 'PICKUP') {
		lines.push('', 'Forma de entrega: Retirada no local');
	} else {
		lines.push('', 'Forma de entrega: Entrega');
		const address = [order.address, order.addressNumber ? `Nº ${order.addressNumber}` : ''].filter(Boolean).join(', ');
		if (address) lines.push('', 'Endereço:', address);
		if (order.neighborhood) lines.push('', 'Bairro:', order.neighborhood);
		if (order.complement) lines.push('', 'Complemento:', order.complement);
		if (order.reference) lines.push('', 'Ponto de referência:', order.reference);
	}
	lines.push(
		'',
		'PEDIDO:',
		...(order.items || []).map(item => `${item.quantity}x ${item.productName} — ${money(item.unitPriceCents * item.quantity / 100)}`),
		'',
		`Subtotal: ${money(order.subtotal)}`,
		`Entrega: ${money(order.deliveryFee)}`,
		`TOTAL: ${money(order.total)}`,
		'',
		'Pagamento: PIX',
		`Comprovante Pix: ${proofUrl || 'arquivo salvo no pedido'}`
	);
	return lines.join('\n');
}

function openOrderWhatsApp(message) {
	const whatsappUrl = `https://wa.me/${orderWhatsAppNumber}?text=${encodeURIComponent(message)}`;
	proofStatus.textContent = 'O comprovante foi salvo no pedido e o link está incluído na mensagem do WhatsApp.';
	proofStatus.classList.remove('is-error');
	window.location.assign(whatsappUrl);
}

$('[data-checkout-form]').addEventListener('submit', async event => {
	event.preventDefault();
	const form = event.currentTarget;
	const message = $('[data-form-message]');
	const proofFile = proofInput.files?.[0];
	if (orderCreated && createdOrderMessage && proofFile) {
		openOrderWhatsApp(createdOrderMessage);
		orderShared = true;
		updateSendOrderButton();
		return;
	}
	if (!proofFile || sendOrderButton.disabled) return;
	message.textContent = 'Registrando seu pedido...';
	sendOrderButton.disabled = true;
	try {
		const formData = new FormData(form);
		formData.delete('pixProof');
		formData.set('paymentMethod', 'PIX');
		formData.set('items', JSON.stringify(cartItems().map(({ product, quantity }) => ({ productId: product.id, quantity: Number(quantity) }))));
		formData.append('proof', proofFile, proofFile.name);
		const endpoint = '/api/orders';
		let response;
		try {
			response = await apiFetch(endpoint, { method: 'POST', body: formData });
		} catch (error) {
			console.error('[POST /api/orders] Requisição não concluída', { endpoint, method: 'POST', message: error.message });
			throw error;
		}
		const responseText = await response.text();
		let result;
		try { result = JSON.parse(responseText); }
		catch { result = { error: responseText || 'Resposta vazia do servidor.' }; }
		if (!response.ok) {
			console.error('[POST /api/orders] Falha no registro', { endpoint, method: 'POST', status: response.status, response: result });
		}
		if (!response.ok) {
			const requestError = new Error(result.error || 'Confira os dados informados.');
			requestError.status = response.status;
			requestError.response = result;
			throw requestError;
		}
		if (!result.order?.id || !result.order?.pixProofUrl) {
			console.error('[POST /api/orders] Resposta sem confirmação do pedido ou comprovante', { endpoint, status: response.status, hasOrderId: Boolean(result.order?.id), hasPixProofUrl: Boolean(result.order?.pixProofUrl) });
			throw new Error('O servidor não confirmou o registro do pedido e do comprovante.');
		}
		orderCreated = true;
		for (const { product, quantity } of cartItems()) product.stock -= quantity;
		state.cart.clear();
		renderMenu();
		renderCart();
		proofInput.disabled = true;
		message.textContent = `Pedido ${result.order.number ? `#${result.order.number}` : 'registrado'}.`;
		$('[data-payment-result]').textContent = 'Seu pedido foi registrado e o comprovante foi anexado.';
		createdOrderMessage = formatCustomerOrderMessage(result.order);
		openOrderWhatsApp(createdOrderMessage);
		orderShared = true;
	} catch (error) {
		console.error('[POST /api/orders] Fluxo Pix encerrado sem confirmação', {
			endpoint: '/api/orders',
			method: 'POST',
			status: error.status ?? null,
			response: error.response ?? null,
			message: error.message,
			stack: error.stack
		});
		message.textContent = error.message;
	} finally {
		updateSendOrderButton();
	}
});

document.addEventListener('click', async event => {
	const copyButton = event.target.closest('[data-copy-pix-key]');
	if (!copyButton) return;
	const pixKey = state.pixPayment?.pixKey;
	if (!pixKey) return;
	try {
		if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(pixKey);
		else throw new Error('Clipboard indisponível.');
	} catch {
		const temporaryInput = document.createElement('textarea');
		temporaryInput.value = pixKey;
		temporaryInput.setAttribute('readonly', '');
		temporaryInput.style.position = 'fixed';
		temporaryInput.style.opacity = '0';
		document.body.append(temporaryInput);
		temporaryInput.select();
		const copied = document.execCommand('copy');
		temporaryInput.remove();
		if (!copied) {
			proofStatus.textContent = 'Não foi possível copiar automaticamente. Selecione a chave Pix para copiar.';
			return;
		}
	}
	proofStatus.textContent = 'Chave PIX copiada.';
});

loadCatalog().then(renderCart).catch(error => { $('[data-form-message]').textContent = error.message; });
loadPixSettings();
