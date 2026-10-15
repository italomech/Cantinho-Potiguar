ALTER TABLE "FidelityEvent" ADD COLUMN "creditStatus" TEXT NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE "FidelityEvent" ADD COLUMN "validOrderCountedAt" DATETIME;

UPDATE "FidelityEvent"
SET "validOrderCountedAt" = "createdAt"
WHERE "type" = 'POINT_EARNED' AND "creditStatus" = 'CONFIRMED';
