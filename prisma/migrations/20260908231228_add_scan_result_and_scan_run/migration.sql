-- CreateTable
CREATE TABLE "ScanResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "namespace" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "expectedType" TEXT NOT NULL,
    "actualValue" TEXT,
    "status" TEXT NOT NULL,
    "lastCheckedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scanRunId" TEXT NOT NULL,
    CONSTRAINT "ScanResult_scanRunId_fkey" FOREIGN KEY ("scanRunId") REFERENCES "ScanRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "totalProductsScanned" INTEGER NOT NULL DEFAULT 0,
    "totalIssuesFound" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING'
);

-- CreateIndex
CREATE INDEX "ScanResult_shop_status_idx" ON "ScanResult"("shop", "status");

-- CreateIndex
CREATE INDEX "ScanResult_shop_key_idx" ON "ScanResult"("shop", "key");

-- CreateIndex
CREATE INDEX "ScanResult_scanRunId_status_idx" ON "ScanResult"("scanRunId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ScanResult_shop_productId_namespace_key_key" ON "ScanResult"("shop", "productId", "namespace", "key");

-- CreateIndex
CREATE INDEX "ScanRun_shop_status_idx" ON "ScanRun"("shop", "status");

-- CreateIndex
CREATE INDEX "ScanRun_shop_startedAt_idx" ON "ScanRun"("shop", "startedAt");
