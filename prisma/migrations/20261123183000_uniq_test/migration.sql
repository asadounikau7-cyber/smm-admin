-- One-week uniqueization test (Andrei, 2026-11-23): only StoryVibe and Velvet publish their own versions,
-- with a stronger edit: hook clip first, the series hook as text for 3 s, more zoom, faster, own colour.
UPDATE "EditTemplate" SET "name" = 'StoryVibe TV — тест уникализации', "notes" = 'Тест с 23.11.2026: сначала 2,5 с кульминации, сверху завязка {hook} 3 с, зум 1,1–1,16, скорость 1,04–1,07.',
  "recipe" = '{"trimStart": 0.5, "trimEnd": null, "maxDuration": null, "hook": null, "zoom": 1.12, "panX": 0, "panY": -0.02, "speed": 1.05, "preset": "cool", "brightness": 0, "contrast": 1.03, "saturation": 1.1, "sharpen": true, "grain": 0, "vignette": false, "fadeIn": 0, "fadeOut": 0, "volume": 1, "texts": [{"text": "{hook}", "from": 0, "to": 3, "pos": "top", "size": 62, "color": "white", "box": true}], "coverTime": 1}'::jsonb,
  "variation" = '{"zoom": [1.1, 1.16], "panX": [-0.15, 0.15], "panY": [-0.08, 0.04], "speed": [1.04, 1.07], "trimStart": [0.3, 1.2], "brightness": [-0.02, 0.03], "saturation": [1.05, 1.18], "hookFrom": [12, 30], "hookLength": 2.5, "hookChance": 1}'::jsonb,
  "updatedAt" = NOW() WHERE "id" = 'tpl_ch_storyvibe';
UPDATE "EditTemplate" SET "name" = 'Velvet Drama — тест уникализации', "notes" = 'Тест с 23.11.2026: сначала 2,5 с кульминации, сверху завязка {hook} 3 с, зум 1,1–1,16, скорость 1,04–1,07.',
  "recipe" = '{"trimStart": 0.5, "trimEnd": null, "maxDuration": null, "hook": null, "zoom": 1.12, "panX": 0, "panY": -0.02, "speed": 1.05, "preset": "vivid", "brightness": 0.02, "contrast": 1, "saturation": 1, "sharpen": false, "grain": 0, "vignette": true, "fadeIn": 0, "fadeOut": 0, "volume": 1, "texts": [{"text": "{hook}", "from": 0, "to": 3, "pos": "top", "size": 62, "color": "yellow", "box": true}], "coverTime": 1}'::jsonb,
  "variation" = '{"zoom": [1.1, 1.16], "panX": [-0.15, 0.15], "panY": [-0.08, 0.04], "speed": [1.04, 1.07], "trimStart": [0.3, 1.2], "brightness": [0, 0.04], "saturation": [0.95, 1.1], "hookFrom": [12, 30], "hookLength": 2.5, "hookChance": 1}'::jsonb,
  "updatedAt" = NOW() WHERE "id" = 'tpl_ch_velvet';
-- The other four main channels publish the original for comparison (their templates stay for later).
UPDATE "SocialAccount" SET "editTemplateId" = NULL WHERE "platform" = 'YOUTUBE' AND "editTemplateId" IN ('tpl_ch_dramaflix', 'tpl_ch_dramarush', 'tpl_ch_plottwist', 'tpl_ch_cliffhanger');
UPDATE "Setting" SET "value" = jsonb_set("value", '{channelVersions}', 'true'::jsonb) WHERE "key" = 'ytConveyor';
