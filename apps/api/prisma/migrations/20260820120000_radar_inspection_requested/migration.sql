-- Async site inspections: POST …/checks only marks the candidate, the radar
-- recheck worker performs the actual inspection and clears the mark.
ALTER TABLE "radar_candidate" ADD COLUMN "inspection_requested_at" TIMESTAMPTZ(6);
