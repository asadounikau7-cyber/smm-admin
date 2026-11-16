-- AlterTable
ALTER TABLE "public"."Asset" ADD COLUMN     "publicUrl" TEXT;

-- AlterTable
ALTER TABLE "public"."Series" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "expectedEpisodes" INTEGER;
