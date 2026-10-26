-- CreateTable
CREATE TABLE "AuditImport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL,
    "fileName" TEXT,
    "auditedUrl" TEXT,
    "auditedHost" TEXT,
    "auditDate" DATETIME,
    "overallScore" INTEGER,
    "grade" TEXT,
    "findingCount" INTEGER NOT NULL,
    "findingsJson" TEXT NOT NULL,
    "importWarnings" TEXT,
    "storeMatch" TEXT NOT NULL,
    "storeMatchNote" TEXT,
    "storeConfirmedAt" DATETIME,
    "storeConfirmedHost" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FixExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "fixType" TEXT NOT NULL,
    "executionKind" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "parentResourceId" TEXT,
    "resourceLabel" TEXT,
    "targetUrl" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "beforeJson" TEXT NOT NULL,
    "proposedJson" TEXT NOT NULL,
    "approvedJson" TEXT,
    "resultJson" TEXT,
    "status" TEXT NOT NULL,
    "verificationStatus" TEXT NOT NULL,
    "verificationJson" TEXT,
    "liveCheckJson" TEXT,
    "errorMessage" TEXT,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "approvedAt" DATETIME,
    "appliedAt" DATETIME,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "FixExecution_importId_fkey" FOREIGN KEY ("importId") REFERENCES "AuditImport" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ThemeFileBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "checksumMd5" TEXT,
    "contentSha256" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AuditImport_shop_createdAt_idx" ON "AuditImport"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "FixExecution_shop_importId_idx" ON "FixExecution"("shop", "importId");

-- CreateIndex
CREATE INDEX "FixExecution_shop_updatedAt_idx" ON "FixExecution"("shop", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FixExecution_shop_dedupeKey_key" ON "FixExecution"("shop", "dedupeKey");

-- CreateIndex
CREATE INDEX "ThemeFileBackup_shop_executionId_idx" ON "ThemeFileBackup"("shop", "executionId");

