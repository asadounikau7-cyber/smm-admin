import { readFile } from "node:fs/promises";
import { agentAuthorized } from "@/lib/agentAuth";
import { FONT_FILE } from "@/lib/renderStore";

/** The font used for text overlays, so renders on the owner's computer look the same as on the server. */
export async function GET(req: Request) {
  if (!agentAuthorized(req)) return new Response("unauthorized", { status: 401 });
  return new Response(new Uint8Array(await readFile(FONT_FILE)), { headers: { "content-type": "font/ttf" } });
}
