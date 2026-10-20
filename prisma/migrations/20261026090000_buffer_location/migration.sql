-- A Buffer store: a location that covers shortages (its count may go negative until the stock is managed).
ALTER TYPE "LocationType" ADD VALUE IF NOT EXISTS 'BUFFER';
