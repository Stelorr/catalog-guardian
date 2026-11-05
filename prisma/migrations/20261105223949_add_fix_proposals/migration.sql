-- AlterTable
ALTER TABLE "ScanResult" ADD COLUMN "flagReason" TEXT;

-- CreateTable
CREATE TABLE "FixProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "ruleType" TEXT NOT NULL,
    "ruleDetail" TEXT NOT NULL,
    "originalValue" TEXT NOT NULL,
    "proposedValue" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "scanRunId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    "appliedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "FixProposal_shop_status_idx" ON "FixProposal"("shop", "status");

-- CreateIndex
CREATE INDEX "FixProposal_shop_productId_namespace_key_idx" ON "FixProposal"("shop", "productId", "namespace", "key");
