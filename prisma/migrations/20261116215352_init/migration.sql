-- CreateEnum
CREATE TYPE "public"."Role" AS ENUM ('OWNER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "public"."Platform" AS ENUM ('YOUTUBE', 'INSTAGRAM', 'TIKTOK');

-- CreateEnum
CREATE TYPE "public"."AssetKind" AS ENUM ('FULL_EPISODE', 'VERTICAL', 'TEASER', 'COVER', 'SUBTITLES');

-- CreateEnum
CREATE TYPE "public"."PostFormat" AS ENUM ('YT_VIDEO', 'YT_SHORT', 'IG_REEL', 'TT_VIDEO');

-- CreateEnum
CREATE TYPE "public"."Visibility" AS ENUM ('PUBLIC', 'UNLISTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "public"."TikTokMode" AS ENUM ('MANUAL', 'PARTNER');

-- CreateEnum
CREATE TYPE "public"."PlanStatus" AS ENUM ('DRAFT', 'APPROVED');

-- CreateEnum
CREATE TYPE "public"."JobStatus" AS ENUM ('DRAFT', 'BLOCKED', 'QUEUED', 'SENT', 'PROCESSING', 'PUBLISHED', 'ACTION_REQUIRED', 'MANUALLY_SCHEDULED', 'FAILED', 'CANCEL_PENDING', 'CANCELLED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "public"."AccountStatus" AS ENUM ('ACTIVE', 'NEEDS_RECONNECT', 'DISABLED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "public"."Role" NOT NULL DEFAULT 'OWNER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Series" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "synopsis" TEXT,
    "hashtags" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Episode" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Asset" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "seriesId" TEXT,
    "episodeId" TEXT,
    "kind" "public"."AssetKind",
    "language" TEXT,
    "variant" TEXT,
    "needsMapping" BOOLEAN NOT NULL DEFAULT true,
    "rightsConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AssetVersion" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "versionKey" TEXT NOT NULL,
    "etag" TEXT,
    "size" BIGINT NOT NULL,
    "lastModified" TIMESTAMP(3) NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "probedAt" TIMESTAMP(3),
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "probeError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SocialAccount" (
    "id" TEXT NOT NULL,
    "platform" "public"."Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "displayName" TEXT,
    "language" TEXT,
    "status" "public"."AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "tiktokMode" "public"."TikTokMode",
    "credentials" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ReleaseRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "seriesId" TEXT NOT NULL,
    "assetKind" "public"."AssetKind" NOT NULL,
    "language" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "format" "public"."PostFormat" NOT NULL,
    "visibility" "public"."Visibility" NOT NULL DEFAULT 'PUBLIC',
    "timezone" TEXT NOT NULL DEFAULT 'America/Winnipeg',
    "slots" JSONB NOT NULL,
    "offsetMinutes" INTEGER,
    "offsetFromRuleId" TEXT,
    "captionTemplate" TEXT NOT NULL DEFAULT '{title} — S{season}E{episode}
{cta}
{hashtags}',
    "cta" TEXT,
    "hashtags" TEXT,
    "strictOrder" BOOLEAN NOT NULL DEFAULT true,
    "madeForKids" BOOLEAN NOT NULL DEFAULT false,
    "aiDisclosure" BOOLEAN NOT NULL DEFAULT false,
    "paidPromotion" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WeeklyPlan" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "public"."PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approveKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeeklyPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PublicationJob" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "ruleId" TEXT,
    "accountId" TEXT NOT NULL,
    "assetVersionId" TEXT,
    "coverKey" TEXT,
    "platform" "public"."Platform" NOT NULL,
    "format" "public"."PostFormat" NOT NULL,
    "visibility" "public"."Visibility" NOT NULL,
    "instanceKey" TEXT NOT NULL,
    "status" "public"."JobStatus" NOT NULL DEFAULT 'DRAFT',
    "blockReasons" JSONB,
    "manualEdit" BOOLEAN NOT NULL DEFAULT false,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "localTime" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "caption" TEXT NOT NULL,
    "title" TEXT,
    "meta" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "rowVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PublicationAttempt" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "step" TEXT NOT NULL,
    "ok" BOOLEAN,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "message" TEXT,
    "state" JSONB,

    CONSTRAINT "PublicationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuditEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "link" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "sentAt" TIMESTAMP(3),
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Series_slug_key" ON "public"."Series"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Episode_seriesId_season_number_key" ON "public"."Episode"("seriesId", "season", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_objectKey_key" ON "public"."Asset"("objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_assetId_versionKey_key" ON "public"."AssetVersion"("assetId", "versionKey");

-- CreateIndex
CREATE UNIQUE INDEX "SocialAccount_platform_externalId_key" ON "public"."SocialAccount"("platform", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyPlan_approveKey_key" ON "public"."WeeklyPlan"("approveKey");

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyPlan_weekStart_key" ON "public"."WeeklyPlan"("weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "PublicationJob_idempotencyKey_key" ON "public"."PublicationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "PublicationJob_status_scheduledAt_idx" ON "public"."PublicationJob"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "PublicationJob_accountId_instanceKey_key" ON "public"."PublicationJob"("accountId", "instanceKey");

-- CreateIndex
CREATE INDEX "AuditEvent_entity_entityId_idx" ON "public"."AuditEvent"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupKey_key" ON "public"."Notification"("dedupKey");

-- AddForeignKey
ALTER TABLE "public"."Episode" ADD CONSTRAINT "Episode_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "public"."Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Asset" ADD CONSTRAINT "Asset_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "public"."Series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Asset" ADD CONSTRAINT "Asset_episodeId_fkey" FOREIGN KEY ("episodeId") REFERENCES "public"."Episode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "public"."Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReleaseRule" ADD CONSTRAINT "ReleaseRule_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "public"."Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ReleaseRule" ADD CONSTRAINT "ReleaseRule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PublicationJob" ADD CONSTRAINT "PublicationJob_planId_fkey" FOREIGN KEY ("planId") REFERENCES "public"."WeeklyPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PublicationJob" ADD CONSTRAINT "PublicationJob_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "public"."ReleaseRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PublicationJob" ADD CONSTRAINT "PublicationJob_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PublicationJob" ADD CONSTRAINT "PublicationJob_assetVersionId_fkey" FOREIGN KEY ("assetVersionId") REFERENCES "public"."AssetVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PublicationAttempt" ADD CONSTRAINT "PublicationAttempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "public"."PublicationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuditEvent" ADD CONSTRAINT "AuditEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
