-- Publishing window widened to 09:00–23:00 (owner's request, 2026-11-19):
-- 6 tests a day per test channel, 5 posts a day per main channel.
UPDATE "Setting"
SET value = jsonb_set(
  jsonb_set(value, '{testSlots}', '["09:00","11:20","13:40","16:00","18:20","20:40"]'::jsonb),
  '{mainSlots}', '["09:00","12:00","15:00","18:00","21:00"]'::jsonb)
WHERE key = 'ytConveyor';
