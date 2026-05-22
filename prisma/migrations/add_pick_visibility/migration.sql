-- CreateEnum PickVisibility
CREATE TYPE "PickVisibility" AS ENUM ('PUBLIC', 'PREMIUM');

-- AlterTable Pick
ALTER TABLE "Pick" ADD COLUMN "visibility" "PickVisibility" NOT NULL DEFAULT 'PUBLIC';

-- CreateIndex
CREATE INDEX "idx_picks_visibility" ON "Pick"("visibility");
