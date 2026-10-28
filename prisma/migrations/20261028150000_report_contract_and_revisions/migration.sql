-- Additive only: new nullable columns, a defaulted column and a unique index.
-- AlterTable
ALTER TABLE "AuditImport" ADD COLUMN "contentDigest" TEXT;
ALTER TABLE "AuditImport" ADD COLUMN "contractVersion" INTEGER;
ALTER TABLE "AuditImport" ADD COLUMN "rawSha256" TEXT;
ALTER TABLE "AuditImport" ADD COLUMN "reportJson" TEXT;
ALTER TABLE "AuditImport" ADD COLUMN "sourceGeneratedAt" DATETIME;
ALTER TABLE "AuditImport" ADD COLUMN "sourceSchemaVersion" INTEGER;

-- AlterTable
ALTER TABLE "FixExecution" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "AuditImport_shop_contentDigest_key" ON "AuditImport"("shop", "contentDigest");
