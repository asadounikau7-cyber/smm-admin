import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string(),
  APP_URL: z.string().default("http://localhost:3000"),
  SESSION_SECRET: z.string().min(32),
  ENCRYPTION_KEY: z.string().min(32),
  BASE_TIMEZONE: z.string().default("America/Winnipeg"),

  B2_ENDPOINT: z.string().optional(),
  B2_REGION: z.string().optional(),
  B2_BUCKET: z.string().optional(),
  B2_KEY_ID: z.string().optional(),
  B2_APP_KEY: z.string().optional(),
  B2_PREFIX: z.string().default(""),
  /// Public catalog page/JSON with the file registry (works without an S3 key)
  B2_REGISTRY_URL: z.string().optional(),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),

  UPLOAD_POST_API_KEY: z.string().optional(),

  /// Shared secret for the Octo agent on the owner's computer (openssl rand -hex 32)
  AGENT_TOKEN: z.string().optional(),

  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  NOTIFY_EMAILS: z.string().optional(),

  CATCHUP_WINDOW_MIN: z.coerce.number().default(30),
  SYNC_INTERVAL_MIN: z.coerce.number().default(15),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;
/** Integration keys entered in «Настройки» (stored encrypted in the DB); they win over .env. */
let overrides: Partial<Env> = {};
let merged: Env | null = null;

export function env(): Env {
  if (!cached) cached = schema.parse(process.env);
  if (!merged) merged = { ...cached, ...overrides };
  return merged;
}

export function setEnvOverrides(o: Partial<Env>) {
  overrides = Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string" && v.trim() !== "")) as Partial<Env>;
  merged = null;
}

/** Value from .env only (to show where a key comes from). */
export function fileEnv(): Env {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function catalogConfigured() {
  return b2Configured() || Boolean(env().B2_REGISTRY_URL);
}

export function b2Configured() {
  const e = env();
  return Boolean(e.B2_ENDPOINT && e.B2_BUCKET && e.B2_KEY_ID && e.B2_APP_KEY);
}
