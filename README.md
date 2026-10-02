# Cantinho Potiguar - pedidos online

## Diagnostico da versao original

O projeto original era uma pagina estatica em HTML, CSS e JavaScript puro, sem backend, banco de dados, autenticacao ou pagamento. A identidade visual foi preservada: fonte Inter, vinho, creme e dourado, layout responsivo e secoes existentes.

## Arquitetura implementada

- Frontend: HTML/CSS/JavaScript vanilla servido pelo Express.
- Backend: Node.js + Express.
- Banco: SQLite local com Prisma. Em producao, pode ser trocado por PostgreSQL alterando o datasource e `DATABASE_URL`.
- Pagamento no checkout: Pix manual. O pedido e o comprovante sao validados e registrados pelo backend; a confirmacao do pagamento continua manual no Admin. A chave configurada e exibida e pode ser copiada; o QR so aparece com um BR Code real que contenha a mesma chave.
- Compartilhamento: Web Share API envia mensagem e arquivo quando suportado. Nos demais dispositivos, abre o WhatsApp/WhatsApp Web com a mensagem pronta e orienta o cliente a anexar o comprovante.
- Compatibilidade legada: rotas Mercado Pago e webhook continuam isolados para pedidos antigos e integrações anteriores; o checkout atual nao cria pagamentos nem redireciona para o Mercado Pago.
- Admin: `/admin`, cookie HTTP-only assinado com JWT e senha armazenada com bcrypt.
- WhatsApp: o cliente escolhe o WhatsApp no compartilhamento do proprio dispositivo. O checkout nao usa Cloud API, webhook WhatsApp, credenciais Meta ou CNPJ.

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
- `UPLOADS_DIR`: pasta onde os comprovantes ficam armazenados. Por padrao usa `uploads/`; no Render, configure para um caminho dentro do disco persistente, por exemplo `/var/data/uploads`.
- `PORT`: porta HTTP.
- `PUBLIC_URL`: URL publica do site.
- `CORS_ORIGIN`: origem permitida pelo CORS.
- `JWT_SECRET`: segredo longo e aleatorio para as sessoes administrativas.
- `ADMIN_EMAIL`, `ADMIN_PASSWORD`: credenciais iniciais do painel.
- `PIX_KEY`: chave Pix real que sera exibida no checkout. Configure-a no `.env` local e no ambiente do servidor.
- `PIX_QR_PAYLOAD`: opcional; payload Pix copia e cola/BR Code real fornecido pelo banco ou PSP. O sistema exibe o QR apenas se o payload for valido e contiver exatamente a chave de `PIX_KEY`. Nao e a chave e nao deve ser inventado.
- `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_ENV`, `MERCADOPAGO_WEBHOOK_SECRET`: nao sao necessarios para o checkout Pix manual; permanecem apenas para rotas legadas.
- `DELIVERY_FEE_CENTS`: taxa inicial de entrega em centavos.
- Variaveis `WHATSAPP_*`: nao sao usadas para o compartilhamento pelo cliente e nao precisam ser configuradas para este checkout.

## Mercado Pago legado

Os endpoints de Checkout Pro e webhook permanecem no backend para compatibilidade com pedidos antigos. Eles nao sao chamados pelo checkout atual. Nao e necessario configurar conta de desenvolvedor Mercado Pago para receber pedidos Pix manuais.

O backend consulta produtos, precos e taxa no banco; nunca aceita o total enviado pelo navegador. O pagamento Pix e confirmado pela equipe no Admin apos conferir o comprovante.

## Producao

- Use um servidor Node (Render, Railway, Fly.io, VPS ou equivalente) com HTTPS.
- Para mais de uma instancia, use PostgreSQL em vez de SQLite e configure backup.
- Configure as variaveis de ambiente no provedor; nao envie `.env` ao repositorio.
- Execute `npm install`, `npm run prisma:generate`, `npm run db:push` e `npm run db:seed` no deploy inicial.
- Configure dominio, HTTPS, `PUBLIC_URL` e CORS. No Render, configure `PIX_KEY`; configure `PIX_QR_PAYLOAD` apenas quando tiver o BR Code real correspondente a essa mesma chave.
- Para manter comprovantes entre deploys, monte um Persistent Disk no Render e defina `UPLOADS_DIR` para uma pasta dentro do ponto de montagem.
- Configure logs, backups, alertas e rotacao das credenciais.

## O que ainda depende de servico externo

O Pix manual depende de uma chave real e da conferencia humana do comprovante. O QR tambem depende de um payload BR Code valido e correspondente fornecido pelo banco/PSP. Compartilhar com o WhatsApp depende do navegador/dispositivo; quando nao ha suporte a arquivos, o cliente precisa anexar o comprovante manualmente.
