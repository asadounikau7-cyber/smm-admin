import { describe, expect, it } from "vitest";
import { invalidKeys } from "./integrationKeys";

describe("integration key formats", () => {
  it("refuses a password slipped into a key field and accepts real-looking keys", () => {
    expect(invalidKeys({ GOOGLE_CLIENT_SECRET: "MyPassw0rd765!" })).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(
      invalidKeys({
        GOOGLE_CLIENT_ID: "1234-abc.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "GOCSPX-AbCdEf_123456789-xyzXYZ",
        B2_KEY_ID: "005a1b2c3d4e5f60000000007",
        B2_APP_KEY: "K005abcdefghijklmnopqrstuvwxgww8",
        UPLOAD_POST_API_KEY: "",
      }),
    ).toEqual([]);
    expect(invalidKeys({ B2_APP_KEY: "hunter2!" })).toEqual(["B2_APP_KEY"]);
  });
});
