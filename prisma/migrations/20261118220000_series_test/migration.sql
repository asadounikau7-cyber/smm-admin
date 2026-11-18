-- CreateEnum
CREATE TYPE "SeriesStage" AS ENUM ('NEW', 'TESTING', 'IN_WORK', 'TEST_FAILED');

-- AlterTable
ALTER TABLE "Series" ADD COLUMN "stage" "SeriesStage" NOT NULL DEFAULT 'NEW',
ADD COLUMN "testJobId" TEXT,
ADD COLUMN "testNote" TEXT,
ADD COLUMN "testLiveAt" TIMESTAMP(3),
ADD COLUMN "testCheckedAt" TIMESTAMP(3),
ADD COLUMN "inWorkAt" TIMESTAMP(3),
ADD COLUMN "launchJobId" TEXT;
