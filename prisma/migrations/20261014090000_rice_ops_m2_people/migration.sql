-- Rice Ops M2: people (PIN, home location), kargadors, signatures, approvals, drafts.
-- Additive only: no existing row changes meaning.

-- Fail fast with a clear "lock timeout" if another session holds a table lock,
-- instead of waiting out the server statement_timeout.
SET lock_timeout = '20s';

-- 1. User PIN + token version
ALTER TABLE "User" ADD COLUMN "pinHash" TEXT,
  ADD COLUMN "pinFailedCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pinLockedUntil" TIMESTAMP(3),
  ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;

-- 2. Home location per membership (empty = every location)
ALTER TABLE "UserStore" ADD COLUMN "homeLocationId" TEXT;
ALTER TABLE "UserStore" ADD CONSTRAINT "UserStore_homeLocationId_fkey"
  FOREIGN KEY ("homeLocationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Enums
CREATE TYPE "SignerKind" AS ENUM ('STAFF', 'KARGADOR', 'CUSTOMER', 'SLIP_PHOTO');
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'CANCELLED');
CREATE TYPE "DraftStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- 4. Kargador
CREATE TABLE "Kargador" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "photoUrl" TEXT,
    "homeLocationId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Kargador_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Kargador_storeId_name_key" ON "Kargador"("storeId", "name");
CREATE INDEX "Kargador_storeId_isActive_idx" ON "Kargador"("storeId", "isActive");
ALTER TABLE "Kargador" ADD CONSTRAINT "Kargador_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Kargador" ADD CONSTRAINT "Kargador_homeLocationId_fkey" FOREIGN KEY ("homeLocationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 5. Signature (insert-only)
CREATE TABLE "Signature" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "signerKind" "SignerKind" NOT NULL,
    "signerUserId" TEXT,
    "kargadorId" TEXT,
    "signerName" TEXT NOT NULL,
    "imagePng" TEXT NOT NULL,
    "imageSha256" TEXT NOT NULL,
    "locationId" TEXT,
    "capturedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Signature_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Signature_storeId_documentType_documentId_idx" ON "Signature"("storeId", "documentType", "documentId");
CREATE INDEX "Signature_storeId_kargadorId_createdAt_idx" ON "Signature"("storeId", "kargadorId", "createdAt");
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_kargadorId_fkey" FOREIGN KEY ("kargadorId") REFERENCES "Kargador"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
-- NO ACTION: a location that holds signatures cannot be deleted (deactivate it instead),
-- and SET NULL would be an UPDATE, which the trigger below refuses.
ALTER TABLE "Signature" ADD CONSTRAINT "Signature_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- A signature is evidence: it can be added, never changed. (Deleting the whole store
-- still cascades; the app has no delete path.)
CREATE OR REPLACE FUNCTION "signature_is_insert_only"() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'Signature rows are insert-only' USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER "Signature_no_update" BEFORE UPDATE ON "Signature"
  FOR EACH ROW EXECUTE FUNCTION "signature_is_insert_only"();

-- 6. ApprovalRequest
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "locationId" TEXT,
    "summary" TEXT NOT NULL,
    "detail" JSONB,
    "approverRoles" TEXT[] DEFAULT ARRAY['OWNER']::TEXT[],
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ApprovalRequest_storeId_status_createdAt_idx" ON "ApprovalRequest"("storeId", "status", "createdAt");
CREATE INDEX "ApprovalRequest_storeId_documentType_documentId_idx" ON "ApprovalRequest"("storeId", "documentType", "documentId");
-- One open question per document and kind (not a Prisma-modelled index: partial).
CREATE UNIQUE INDEX "ApprovalRequest_one_pending" ON "ApprovalRequest"("storeId", "kind", "documentType", "documentId") WHERE "status" = 'PENDING';
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 7. FlowDraft
CREATE TABLE "FlowDraft" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "flow" TEXT NOT NULL,
    "locationId" TEXT,
    "docNumber" TEXT,
    "step" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'OPEN',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FlowDraft_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FlowDraft_storeId_status_locationId_idx" ON "FlowDraft"("storeId", "status", "locationId");
ALTER TABLE "FlowDraft" ADD CONSTRAINT "FlowDraft_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FlowDraft" ADD CONSTRAINT "FlowDraft_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 8. Same lock-down as every public table (Supabase Data API must not reach these).
ALTER TABLE "Kargador" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Signature" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ApprovalRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FlowDraft" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION "signature_is_insert_only"() FROM PUBLIC;
