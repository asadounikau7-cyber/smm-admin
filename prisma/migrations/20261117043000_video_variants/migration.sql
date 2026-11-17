-- CreateEnum
CREATE TYPE "public"."VariantStatus" AS ENUM ('PENDING', 'RENDERING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "public"."Asset" ADD COLUMN     "renderOfId" TEXT;

-- AlterTable
ALTER TABLE "public"."ReleaseRule" ADD COLUMN     "requireVariant" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "public"."EditTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "notes" TEXT,
    "recipe" JSONB NOT NULL,
    "variation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EditTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."VideoVariant" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "language" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "sourceAssetId" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "templateId" TEXT,
    "recipe" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "accountId" TEXT,
    "status" "public"."VariantStatus" NOT NULL DEFAULT 'PENDING',
    "renderer" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "renderedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VideoVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VideoVariant_code_key" ON "public"."VideoVariant"("code");

-- CreateIndex
CREATE INDEX "VideoVariant_status_createdAt_idx" ON "public"."VideoVariant"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "VideoVariant_episodeId_accountId_key" ON "public"."VideoVariant"("episodeId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "VideoVariant_episodeId_signature_key" ON "public"."VideoVariant"("episodeId", "signature");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_renderOfId_key" ON "public"."Asset"("renderOfId");

-- AddForeignKey
ALTER TABLE "public"."Asset" ADD CONSTRAINT "Asset_renderOfId_fkey" FOREIGN KEY ("renderOfId") REFERENCES "public"."VideoVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VideoVariant" ADD CONSTRAINT "VideoVariant_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "public"."Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VideoVariant" ADD CONSTRAINT "VideoVariant_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "public"."Episode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VideoVariant" ADD CONSTRAINT "VideoVariant_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "public"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VideoVariant" ADD CONSTRAINT "VideoVariant_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "public"."AssetVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VideoVariant" ADD CONSTRAINT "VideoVariant_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "public"."EditTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."VideoVariant" ADD CONSTRAINT "VideoVariant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

