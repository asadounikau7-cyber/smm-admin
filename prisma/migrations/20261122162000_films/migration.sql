CREATE TYPE "CompilationStatus" AS ENUM ('QUEUED', 'BUILDING', 'READY', 'TESTING', 'PASSED', 'FAILED', 'SCHEDULED', 'PUBLISHED');

CREATE TABLE "Compilation" (
    "id" TEXT NOT NULL,
    "seriesId" TEXT NOT NULL,
    "status" "CompilationStatus" NOT NULL DEFAULT 'QUEUED',
    "episodes" INTEGER NOT NULL DEFAULT 0,
    "durationSec" DOUBLE PRECISION,
    "chapters" JSONB,
    "assetVersionId" TEXT,
    "testJobId" TEXT,
    "mainJobId" TEXT,
    "accountId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Compilation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Compilation_seriesId_key" ON "Compilation"("seriesId");
CREATE INDEX "Compilation_status_idx" ON "Compilation"("status");
ALTER TABLE "Compilation" ADD CONSTRAINT "Compilation_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
