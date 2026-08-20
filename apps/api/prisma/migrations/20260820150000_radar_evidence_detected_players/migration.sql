-- Players recognized by the signature catalog during L0/L1 inspection.
ALTER TABLE "radar_evidence" ADD COLUMN "detected_players" JSONB;
