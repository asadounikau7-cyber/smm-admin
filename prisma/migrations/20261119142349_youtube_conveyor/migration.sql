-- CreateEnum
CREATE TYPE "public"."AccountRole" AS ENUM ('MAIN', 'TEST');

-- AlterTable
ALTER TABLE "public"."Series" ADD COLUMN     "allowedGeos" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "testQueuedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."SocialAccount" ADD COLUMN     "geo" TEXT,
ADD COLUMN     "role" "public"."AccountRole" NOT NULL DEFAULT 'MAIN';

-- CreateTable
CREATE TABLE "public"."ChannelQueueItem" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "episodeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelQueueItem_accountId_jobId_idx" ON "public"."ChannelQueueItem"("accountId", "jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelQueueItem_accountId_episodeId_key" ON "public"."ChannelQueueItem"("accountId", "episodeId");

-- AddForeignKey
ALTER TABLE "public"."ChannelQueueItem" ADD CONSTRAINT "ChannelQueueItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelQueueItem" ADD CONSTRAINT "ChannelQueueItem_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "public"."Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
