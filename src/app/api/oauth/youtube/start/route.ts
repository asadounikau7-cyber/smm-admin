import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { beginOAuth } from "@/lib/oauthState";
import { googleAuthUrl } from "@/lib/adapters/youtube";

export async function GET() {
  await requireOwner();
  const { state, challenge } = await beginOAuth("youtube");
  return NextResponse.redirect(googleAuthUrl(state, challenge));
}
