-- CreateEnum
CREATE TYPE "public"."AgentCommandType" AS ENUM ('START_PROFILE', 'STOP_PROFILE', 'LIST_PROFILES');

-- CreateEnum
CREATE TYPE "public"."AgentCommandStatus" AS ENUM ('PENDING', 'TAKEN', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "public"."SocialAccount" ADD COLUMN     "octoProfileId" TEXT;

-- CreateTable
CREATE TABLE "public"."OctoProfile" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "octoUuid" TEXT,
    "proxyNote" TEXT,
    "notes" TEXT,
    "running" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OctoProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentCommand" (
    "id" TEXT NOT NULL,
    "type" "public"."AgentCommandType" NOT NULL,
    "profileId" TEXT,
    "url" TEXT,
    "status" "public"."AgentCommandStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB,
    "error" TEXT,
    "createdById" TEXT,
    "takenAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCommand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OctoProfile_octoUuid_key" ON "public"."OctoProfile"("octoUuid");

-- CreateIndex
CREATE INDEX "AgentCommand_status_createdAt_idx" ON "public"."AgentCommand"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."SocialAccount" ADD CONSTRAINT "SocialAccount_octoProfileId_fkey" FOREIGN KEY ("octoProfileId") REFERENCES "public"."OctoProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentCommand" ADD CONSTRAINT "AgentCommand_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "public"."OctoProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
