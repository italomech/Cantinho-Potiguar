import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const products = [
  ['Creme de Frango', 'Delicioso creme de frango com sabor caseiro e acompanhamento perfeito.', 'https://www.receitasja.com.br/wp-content/uploads/2025/06/Creme-de-galinha-com-mandioquinha-1140x597.jpg'],
  ['Panqueca', 'Panqueca macia, saborosa e muito bem preparada para surpreender.', 'https://guiadacozinha.com.br/wp-content/uploads/2018/04/panqueca-de-frango-com-palmito-_1_.webp'],
  ['Strogonoff', 'Strogonoff cremoso, cheio de sabor e com aquele toque de casa.', 'https://edge.osuper.com.br/LQJFRlnTMY6Q1dY_HVtV8BRogr4=/0x600/smart/https://osuper-ecommerce-koch.s3.sa-east-1.amazonaws.com/684cc08a-chatgpt-image-17072026-170028.png'],
  ['Lasanha', 'Lasanha bem recheada, gratinada e com sabor irresistível.', 'https://espaconatelie.com.br/wp-content/uploads/2025/05/lasanha-de-frango.jpg'],
  ['Escondidinho de Carne', 'Uma opção irresistível, com carne suculenta e aquele sabor de comida caseira.', 'https://tudodelicious.com/wp-content/uploads/2025/04/Escondidinho-de-carne-moida-1024x1024.jpg']
];

async function main() {
  const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'troque-esta-senha', 12);
  await prisma.admin.upsert({
    where: { email: process.env.ADMIN_EMAIL || 'admin@cantinhopotiguar.com.br' },
    update: { passwordHash },
    create: { email: process.env.ADMIN_EMAIL || 'admin@cantinhopotiguar.com.br', passwordHash }
  });
  await prisma.setting.upsert({ where: { id: 'main' }, update: {}, create: { deliveryFeeCents: Number(process.env.DELIVERY_FEE_CENTS || 500) } });
  for (const [name, description, imageUrl] of products) {
    const existing = await prisma.product.findFirst({ where: { name } });
    if (!existing) await prisma.product.create({ data: { name, description, imageUrl, priceCents: 1500 } });
  }
}

main().finally(() => prisma.$disconnect());
