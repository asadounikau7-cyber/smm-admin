-- Andrei 2026-11-24: films go out as soon as they pass their check, not at 19:30.
UPDATE "Setting" SET "value" = jsonb_set("value", '{filmAsap}', 'true'::jsonb) WHERE "key" = 'ytConveyor';
