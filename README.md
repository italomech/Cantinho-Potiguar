# Cantinho Potiguar - pedidos online

## Diagnostico da versao original

O projeto original era uma pagina estatica em HTML, CSS e JavaScript puro, sem backend, banco de dados, autenticacao ou pagamento. A identidade visual foi preservada: fonte Inter, vinho, creme e dourado, layout responsivo e secoes existentes.

## Arquitetura implementada

- Frontend: HTML/CSS/JavaScript vanilla servido pelo Express.
- Backend: Node.js + Express.
- Banco: SQLite local com Prisma. Em producao, pode ser trocado por PostgreSQL alterando o datasource e `DATABASE_URL`.
- Pagamento no checkout: Pix manual, dinheiro na entrega e cartao na entrega. Pix permanece pendente ate a equipe conferir o comprovante no Admin; dinheiro e cartao na entrega permanecem pendentes ate a equipe confirmar o recebimento. O valor informado para troco e validado e salvo separadamente do total.
- Reenvio seguro: um token unico por checkout evita criar pedidos duplicados quando o navegador repete a mesma requisicao.
- Confirmacao do checkout: apos registrar o pedido no backend, a pagina mostra o numero, valores e status e oferece um link do WhatsApp com o resumo do pedido.
- Compatibilidade legada: rotas Mercado Pago e webhook continuam isolados para pedidos antigos e integrações anteriores; o checkout atual nao cria pagamentos nem redireciona para o Mercado Pago.
- Admin: `/admin`, cookie HTTP-only assinado com JWT e senha armazenada com bcrypt.
- WhatsApp: o cliente escolhe o WhatsApp no compartilhamento do proprio dispositivo. O checkout nao usa Cloud API, webhook WhatsApp, credenciais Meta ou CNPJ.

## Instalar e executar localmente

Requisito: Node.js 20 LTS ou superior.

```powershell
Copy-Item .env.example .env
npm install
npm run prisma:generate
npm run db:migrate
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
- `PIX_KEY`: opcional; sobrescreve a chave Pix padrão centralizada no backend. Configure esta variável quando quiser usar outra chave em um ambiente.
- `PIX_QR_PAYLOAD`: opcional; payload Pix copia e cola/BR Code real fornecido pelo banco ou PSP. O sistema exibe o QR apenas se o payload for valido e contiver exatamente a chave de `PIX_KEY`. Nao e a chave e nao deve ser inventado.
- `MERCADOPAGO_ACCESS_TOKEN`, `MERCADOPAGO_ENV`, `MERCADOPAGO_WEBHOOK_SECRET`: nao sao necessarios para o checkout Pix manual; permanecem apenas para rotas legadas.
- `DELIVERY_FEE_CENTS`: taxa inicial de entrega em centavos.
- Variaveis `WHATSAPP_*`: nao sao usadas para o compartilhamento pelo cliente e nao precisam ser configuradas para este checkout.

## Mercado Pago legado

Os endpoints de Checkout Pro e webhook permanecem no backend para compatibilidade com pedidos antigos. Eles nao sao chamados pelo checkout atual. Nao e necessario configurar conta de desenvolvedor Mercado Pago para receber pedidos Pix manuais.

O backend consulta produtos, precos e taxa no banco; nunca aceita o total enviado pelo navegador. O pagamento Pix e confirmado pela equipe no Admin apos conferir o comprovante.

## Cartao fidelidade

Cada telefone brasileiro normalizado identifica um cartao. Um pedido concede um ponto uma unica vez, somente quando `paymentStatus` esta `APPROVED` e `orderStatus` esta `COMPLETED`; quantidade de itens, comprovante enviado ou criacao do pedido nao contam como confirmacao. A decima compra valida emite uma recompensa de um pedido gratis. Pedidos validos feitos enquanto essa recompensa aguarda resgate ficam guardados para o ciclo seguinte.

O painel `/admin` lista os cartoes, permite registrar resgates e exige uma justificativa para resolver cancelamentos que afetem pontos ou recompensas. Um cancelamento antes da emissao da recompensa estorna o ponto; se a recompensa ja foi emitida ou resgatada, o saldo e congelado para revisao administrativa. A equipe deve conferir as regras e produtos elegiveis antes de conceder o pedido gratis.

Por seguranca, o progresso nao e consultavel publicamente apenas digitando um telefone: nao ha verificacao de titularidade por codigo/OTP no sistema. O cliente deve solicitar a consulta a equipe pelo WhatsApp oficial. As respostas publicas de pedidos nao incluem o telefone normalizado nem o saldo de fidelidade; a consulta detalhada exige acesso administrativo.

A migracao `0006_digital_loyalty_card` e aditiva. Na inicializacao, pedidos antigos com telefone valido sao associados ao cartao e apenas os que ja estao pagos e concluidos sao considerados no historico. Execute `npm run test:fidelity` para testar elegibilidade, idempotencia, ciclos, cancelamentos e resgates em um banco temporario.

## Producao

- Use um servidor Node (Render, Railway, Fly.io, VPS ou equivalente) com HTTPS.
- Para mais de uma instancia, use PostgreSQL em vez de SQLite e configure backup.
- Configure as variaveis de ambiente no provedor; nao envie `.env` ao repositorio.
- Execute `npm install`, `npm run prisma:generate`, `npm run db:migrate` e `npm run db:seed` no deploy inicial. `migrate deploy` aplica todas as migrações novas sem recriar o banco.
- Configure dominio, HTTPS, `PUBLIC_URL` e CORS. A chave Pix padrão está no backend; configure `PIX_KEY` no Render apenas se precisar sobrescrevê-la. Configure `PIX_QR_PAYLOAD` somente quando tiver o BR Code real correspondente a essa mesma chave.
- Causa das alteracoes que desaparecem: SQLite e arquivos enviados ficam no sistema de arquivos local. Em hospedagens com disco efemero, dados podem sumir em novo deploy ou reinicio. O seed nao substitui imagens quando ja existem produtos no banco; o disco efemero torna dados gravados indisponiveis.
- Para manter pedidos, produtos e configuracoes, configure `DATABASE_URL` para um banco persistente ou mova o SQLite para um Persistent Disk. Em Render com SQLite, monte o disco e use, por exemplo, `DATABASE_URL=file:/var/data/dev.db`.
- Para manter comprovantes e fotos de produtos, configure `UPLOADS_DIR=/var/data/uploads` em um Persistent Disk montado. Os arquivos sao publicados em `/uploads/`; nao use diretorio temporario ou efemero.
- A migracao `0005_delivery_payment_options` adiciona campos opcionais de troco e token idempotente, sem remover tabelas nem pedidos existentes.
- A migração `0003_product_inventory` adiciona categoria, estoque informativo e disponibilidade manual; `0004_manual_product_availability` define todos os produtos existentes como disponíveis. Estoque vazio ou zerado não bloqueia produtos nem é reduzido pelas vendas.
- A criação de pedidos valida o bairro e a disponibilidade manual no backend. Marque explicitamente Esgotado no Admin para bloquear compras; reative como Disponível para voltar a vender.
- Configure logs, backups, alertas e rotacao das credenciais.

## O que ainda depende de servico externo

O Pix manual depende de uma chave real e da conferencia humana do comprovante. O QR tambem depende de um payload BR Code valido e correspondente fornecido pelo banco/PSP. A chave Pix existente no backend e mantida; o titular e o banco exibidos no checkout sao MELIZIA SUELLY DA SILVA e Santander. Compartilhar com o WhatsApp depende do navegador/dispositivo; quando nao ha suporte a arquivos, o cliente precisa anexar o comprovante manualmente. A hospedagem precisa de banco e volume de arquivos persistentes configurados; o codigo nao consegue tornar duravel um disco efemero do provedor.
