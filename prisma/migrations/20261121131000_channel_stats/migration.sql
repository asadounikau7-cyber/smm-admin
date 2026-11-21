-- CreateTable
CREATE TABLE "public"."ChannelStat" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "subscribers" INTEGER NOT NULL,
    "views" INTEGER NOT NULL,
    "videos" INTEGER NOT NULL,
    "likes" INTEGER NOT NULL,
    "comments" INTEGER NOT NULL,
    "publicVideos" INTEGER NOT NULL,
    "top" JSONB,
    "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelStat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChannelStat_accountId_day_key" ON "public"."ChannelStat"("accountId", "day");

-- AddForeignKey
ALTER TABLE "public"."ChannelStat" ADD CONSTRAINT "ChannelStat_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

