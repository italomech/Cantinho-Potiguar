ALTER TABLE "Order" ADD COLUMN "phoneNormalized" TEXT;

CREATE TABLE "FidelityAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phoneNormalized" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "queuedPoints" INTEGER NOT NULL DEFAULT 0,
    "validOrdersCount" INTEGER NOT NULL DEFAULT 0,
    "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "FidelityReward" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "cycle" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redeemedAt" DATETIME,
    "redeemedBy" TEXT,
    CONSTRAINT "FidelityReward_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FidelityAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "FidelityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "orderId" TEXT,
    "rewardId" TEXT,
    "type" TEXT NOT NULL,
    "bucket" TEXT,
    "cycle" INTEGER,
    "pointsDelta" INTEGER NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "reviewResolution" TEXT,
    "resolvedBy" TEXT,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FidelityEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "FidelityAccount" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FidelityEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "FidelityEvent_rewardId_fkey" FOREIGN KEY ("rewardId") REFERENCES "FidelityReward" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "FidelityAccount_phoneNormalized_key" ON "FidelityAccount"("phoneNormalized");
CREATE UNIQUE INDEX "FidelityReward_accountId_cycle_key" ON "FidelityReward"("accountId", "cycle");
CREATE INDEX "FidelityReward_accountId_status_idx" ON "FidelityReward"("accountId", "status");
CREATE UNIQUE INDEX "FidelityEvent_idempotencyKey_key" ON "FidelityEvent"("idempotencyKey");
CREATE INDEX "FidelityEvent_accountId_createdAt_idx" ON "FidelityEvent"("accountId", "createdAt");
CREATE INDEX "FidelityEvent_orderId_idx" ON "FidelityEvent"("orderId");
