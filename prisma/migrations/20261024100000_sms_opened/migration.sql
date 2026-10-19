-- "Text opened": the phone's own SMS app was opened with the message ready. It is never "sent" —
-- only the person pressing Send on the phone knows that.
ALTER TYPE "SmsStatus" ADD VALUE IF NOT EXISTS 'OPENED';
