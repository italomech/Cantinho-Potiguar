-- Bring the deployed SQLite schema in line with the current Prisma models.
ALTER TABLE "Product" ADD COLUMN "costCents" INTEGER;

ALTER TABLE "Order" ADD COLUMN "feeCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "pixProofUrl" TEXT;
ALTER TABLE "Order" ADD COLUMN "pixProofMime" TEXT;
ALTER TABLE "Order" ADD COLUMN "pixProofStatus" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "Order" ADD COLUMN "pixProofUploadedAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "pixProofConfirmedAt" DATETIME;
ALTER TABLE "Order" ADD COLUMN "pixProofConfirmedBy" TEXT;

CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "createdBy" TEXT
);

CREATE TABLE "CashClosure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingBalanceCents" INTEGER NOT NULL,
    "totalSoldCents" INTEGER NOT NULL,
    "totalReceivedCents" INTEGER NOT NULL,
    "cashCents" INTEGER NOT NULL,
    "pixCents" INTEGER NOT NULL,
    "cardCents" INTEGER NOT NULL,
    "feesCents" INTEGER NOT NULL,
    "expensesCents" INTEGER NOT NULL,
    "manualEntriesCents" INTEGER NOT NULL,
    "manualOutputsCents" INTEGER NOT NULL,
    "closingBalanceCents" INTEGER NOT NULL,
    "profitCents" INTEGER NOT NULL
);
