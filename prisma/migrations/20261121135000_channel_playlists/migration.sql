CREATE TABLE "ChannelPlaylist" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "playlistId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChannelPlaylist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ChannelPlaylist_accountId_seriesId_key" ON "ChannelPlaylist"("accountId", "seriesId");
ALTER TABLE "ChannelPlaylist" ADD CONSTRAINT "ChannelPlaylist_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
