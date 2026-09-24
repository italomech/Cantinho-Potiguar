# Cantinho Potiguar - pedidos online

## Diagnostico da versao original

O projeto original era uma pagina estatica em HTML, CSS e JavaScript puro, sem backend, banco de dados, autenticacao ou pagamento. A identidade visual foi preservada: fonte Inter, vinho, creme e dourado, layout responsivo e secoes existentes.

## Arquitetura implementada

- Frontend: HTML/CSS/JavaScript vanilla servido pelo Express.
- Backend: Node.js + Express.
- Banco: SQLite local com Prisma. Em producao, pode ser trocado por PostgreSQL alterando o datasource e `DATABASE_URL`.
- Pagamento: API oficial Orders do Mercado Pago no backend. Pix usa `POST /v1/orders` com processamento automatico, `X-Idempotency-Key`, QR Code e Pix Copia e Cola; cartao permanece no Checkout Pro.
- Confirmacao: webhook `POST /api/webhooks/mercadopago`, que consulta a order no Mercado Pago e atualiza o pedido somente apos confirmacao, com validacao HMAC quando `MERCADOPAGO_WEBHOOK_SECRET` estiver configurado.
- Admin: `/admin`, cookie HTTP-only assinado com JWT e senha armazenada com bcrypt.
- WhatsApp: o sistema deixa `ADMIN_WHATSAPP` preparado, mas o envio automatico exige WhatsApp Business Platform/Cloud API ou provedor oficial. Nenhum metodo nao oficial foi usado.

## Instalar e executar localmente

Requisito: Node.js 20 LTS ou superior.

```powershell
Copy-Item .env.example .env
npm install
npm run prisma:generate
npm run db:push
npm run db:seed
npm run dev
```

Abra `http://localhost:3000`. O painel fica em `http://localhost:3000/admin`.

O seed cria o administrador usando `ADMIN_EMAIL` e `ADMIN_PASSWORD` do `.env`. Troque a senha antes de qualquer ambiente acessivel publicamente.

O site precisa ser aberto pelo Express em `http://localhost:3000`. Nao abra `index.html` diretamente nem use apenas Live Server: esses modos exibem o HTML, mas nao executam a API `/api/products`, `/api/settings` e `/api/orders`, causando `Failed to fetch` no checkout.

## Variaveis `.env`

- `DATABASE_URL`: banco Prisma, por exemplo `file:./dev.db`.
- `PORT`: porta HTTP.
- `PUBLIC_URL`: URL publica do site.
- `CORS_ORIGIN`: origem permitida pelo CORS.
- `JWT_SECRET`: segredo longo e aleatorio para as sessoes administrativas.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: credenciais iniciais do painel.
- `MERCADOPAGO_ACCESS_TOKEN`: Access Token privado de teste, somente no `.env` do servidor. Nunca coloque este valor em `index.html`, `script.js` ou outro arquivo servido ao navegador.
- `MERCADOPAGO_PUBLIC_KEY`: chave publica de teste. O Checkout Pro hospedado nao precisa dela no frontend; mantenha-a no `.env` caso a integracao futura use Bricks.
- `MERCADOPAGO_ENV`: deixe `test` durante a homologacao. O backend somente usa `production` quando esse valor for definido explicitamente.
- `MERCADOPAGO_WEBHOOK_SECRET`: segredo de assinatura gerado na configuracao dos webhooks. Em homologacao, preencha-o para que as notificacoes sejam autenticadas.
- `PAYMENT_PAYER_EMAIL`: e-mail do pagador usado na criacao do Pix. Com `MERCADOPAGO_ENV="test"`, use o e-mail do usuario comprador de teste criado no painel do Mercado Pago, normalmente terminado em `@testuser.com`; nao use o e-mail real da loja. Em producao, use um e-mail valido conforme a conta e as regras da API.
- `DELIVERY_FEE_CENTS`: taxa inicial de entrega em centavos.
- `ADMIN_WHATSAPP`: numero de destino em formato internacional para a WhatsApp Cloud API.
- `WHATSAPP_ACCESS_TOKEN`: token permanente ou de sistema da aplicacao Meta, somente no `.env` do servidor.
- `WHATSAPP_PHONE_NUMBER_ID`: ID do numero de telefone configurado no WhatsApp Business.
- `WHATSAPP_GRAPH_API_VERSION`: versao da Graph API aprovada para a conta, por exemplo `vXX.X` conforme o painel/documentacao da Meta.
- `WHATSAPP_TEMPLATE_NAME`: nome de um template aprovado pela Meta com um placeholder de corpo para receber a mensagem completa do pedido.
- `WHATSAPP_TEMPLATE_LANGUAGE`: idioma do template, normalmente `pt_BR`.

## Mercado Pago

1. Acesse `https://www.mercadopago.com.br/developers/panel/app` e entre na conta de desenvolvedor.
2. Crie ou abra uma aplicacao e entre em `Credenciais de teste`.
3. Copie o `Access Token de teste` para `MERCADOPAGO_ACCESS_TOKEN` no arquivo `.env` local. Copie também a `Public Key de teste` para `MERCADOPAGO_PUBLIC_KEY` se quiser mantê-la preparada para uma futura integração com Bricks.
4. Mantenha `MERCADOPAGO_ENV="test"`, `PUBLIC_URL="http://localhost:3000"` e `CORS_ORIGIN="http://localhost:3000"` durante o teste local.
5. Para receber webhooks localmente, publique a porta 3000 com um túnel HTTPS (por exemplo, ngrok ou Cloudflare Tunnel). No painel, abra `Webhooks`, crie uma URL de teste para `https://SEU-TUNEL/api/webhooks/mercadopago`, selecione o evento `Pagamentos` e copie o segredo de assinatura para `MERCADOPAGO_WEBHOOK_SECRET`.
6. Reinicie o backend depois de alterar o `.env`. O carrinho envia apenas IDs e quantidades; o backend consulta produtos, preços e taxa no banco antes de criar o pagamento.
7. Use usuários de teste comprador e vendedor criados em `Contas de teste` no painel. Configure `MERCADOPAGO_ACCESS_TOKEN` com o Access Token de teste do vendedor e `PAYMENT_PAYER_EMAIL` com o e-mail do comprador de teste. Não use credenciais reais na homologação. Para Pix, a conta de teste vendedor precisa estar habilitada para receber pagamentos. O QR gerado com credenciais de teste deve ser validado no fluxo de teste do Mercado Pago; para aceitar pagamentos pelo aplicativo/conta de produção, use credenciais de produção, `MERCADOPAGO_ENV="production"` e uma conta vendedora de produção.

O pedido nasce como pendente. Somente uma consulta autenticada ao pagamento no Mercado Pago, disparada pelo webhook ou pelo polling do checkout, muda `paymentStatus` para `APPROVED` e `orderStatus` para `PAID`. Depois disso, o backend tenta enviar a mensagem pela WhatsApp Cloud API uma única vez por pedido. O total nunca e aceito do navegador.

Para o envio automatico, crie na Meta um template aprovado para mensagem iniciada pela empresa. O template deve conter um placeholder no corpo, pois o sistema envia a mensagem completa do pedido como esse parametro. Sem as variaveis da Cloud API e sem template aprovado, o pagamento continua funcionando, mas o servidor registra o erro e nao simula um envio.

## Producao

- Use um servidor Node (Render, Railway, Fly.io, VPS ou equivalente) com HTTPS.
- Para mais de uma instancia, use PostgreSQL em vez de SQLite e configure backup.
- Configure as variaveis de ambiente no provedor; nao envie `.env` ao repositorio.
- Execute `npm install`, `npm run prisma:generate`, `npm run db:push` e `npm run db:seed` no deploy inicial.
- Configure dominio, HTTPS, `PUBLIC_URL`, CORS e o webhook no mesmo dominio.
- Configure logs, backups, alertas e rotacao das credenciais.

## O que ainda depende de servico externo

O recebimento real de dinheiro depende de uma conta Mercado Pago verificada, credenciais, dominio HTTPS e webhook acessivel publicamente. Pix e cartao nao podem ser homologados completamente sem essas configuracoes.

A notificacao automatica por WhatsApp nao e ativada apenas com um numero. Ela exige uma conta WhatsApp Business, Meta Business verificada, template aprovado e token da Cloud API ou um provedor oficial. O numero `ADMIN_WHATSAPP` esta reservado para essa etapa.
