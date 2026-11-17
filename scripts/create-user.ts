/** Usage: npm run user:create -- owner@example.com 'long-password' [OWNER|OPERATOR] */
import bcrypt from "bcryptjs";
import { db } from "../src/lib/db";

async function main() {
  const [email, password, role = "OWNER"] = process.argv.slice(2);
  if (!email || !password || password.length < 4) {
    console.error("Usage: npm run user:create -- <email> <password (4+ chars)> [OWNER|OPERATOR]");
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const u = await db.user.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, role: role as "OWNER" | "OPERATOR" },
    create: { email: email.toLowerCase(), passwordHash, role: role as "OWNER" | "OPERATOR" },
  });
  console.log(`OK: ${u.email} (${u.role})`);
  await db.$disconnect();
}
main();
