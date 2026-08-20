-- Outcome feedback for Partner Score calibration: a structured rejection
-- reason plus the score/formula fixed at the moment of the decision.
ALTER TABLE "radar_decision" ADD COLUMN "reason_code" VARCHAR(64);
ALTER TABLE "radar_decision" ADD COLUMN "score_at_decision" INTEGER;
ALTER TABLE "radar_decision" ADD COLUMN "formula_version" VARCHAR(64);
