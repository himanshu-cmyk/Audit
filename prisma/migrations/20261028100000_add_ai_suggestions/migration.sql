-- CreateTable
CREATE TABLE "AiSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "executionId" TEXT,
    "kind" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "outputJson" TEXT,
    "validationJson" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AiSuggestion_shop_createdAt_idx" ON "AiSuggestion"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "AiSuggestion_shop_executionId_idx" ON "AiSuggestion"("shop", "executionId");

-- CreateIndex
CREATE INDEX "AiSuggestion_shop_importId_findingKey_idx" ON "AiSuggestion"("shop", "importId", "findingKey");
