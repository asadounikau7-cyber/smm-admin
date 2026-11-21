-- Clean test passes used to record only the geos that had a main channel at the time (US).
-- A clean pass plays everywhere, so those series may go to every geo.
UPDATE "Series"
SET "allowedGeos" = ARRAY['US', 'UK']
WHERE "stage" = 'IN_WORK'
  AND "testNote" LIKE 'Прошёл%'
  AND "testNote" NOT LIKE '%(только%';
