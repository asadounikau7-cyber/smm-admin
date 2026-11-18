import { loadIntegrationKeys } from "@/lib/integrationKeys";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { beginOAuth } from "@/lib/oauthState";
import { igAuthUrl } from "@/lib/adapters/instagram";

export async function GET() {
  await loadIntegrationKeys();
  await requireOwner();
  const { state } = await beginOAuth("instagram");
  return NextResponse.redirect(igAuthUrl(state));
}
