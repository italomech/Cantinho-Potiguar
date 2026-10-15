ALTER TABLE "Order" ADD COLUMN "cashTenderedCents" INTEGER;
ALTER TABLE "Order" ADD COLUMN "cashChangeCents" INTEGER;
ALTER TABLE "Order" ADD COLUMN "checkoutToken" TEXT;
CREATE UNIQUE INDEX "Order_checkoutToken_key" ON "Order"("checkoutToken");
