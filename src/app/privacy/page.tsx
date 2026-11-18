export const metadata = { title: "Privacy policy · SMM Admin" };

/** Public page required by Google's OAuth consent screen. */
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6 text-sm leading-6">
      <h1 className="text-xl font-semibold">Privacy policy</h1>
      <p>
        SMM Admin is an internal tool of Timand Inc. used only by its own staff to upload and schedule the company&apos;s videos on
        YouTube channels that the company owns or manages. It is not offered to the public.
      </p>
      <h2 className="font-medium">What we access</h2>
      <p>
        When a channel owner connects a YouTube channel, the tool receives an OAuth token from Google with the scopes needed to upload
        videos, set their privacy, schedule and thumbnails, and read their processing status. We do not read comments, subscribers,
        analytics or any other data.
      </p>
      <h2 className="font-medium">How we store it</h2>
      <p>
        Tokens are stored encrypted on the company&apos;s own server and are used only to publish the company&apos;s videos to the
        connected channel. They are never sold, shared with third parties or used for advertising.
      </p>
      <h2 className="font-medium">Removing access</h2>
      <p>
        A channel can be disconnected at any time in the tool, or access can be revoked at
        {" "}<a className="underline" href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
        After that the token is deleted on the next use attempt.
      </p>
      <p>
        SMM Admin&apos;s use of information received from Google APIs adheres to the Google API Services User Data Policy, including
        the Limited Use requirements. YouTube API Services are used under the YouTube Terms of Service
        (<a className="underline" href="https://www.youtube.com/t/terms">youtube.com/t/terms</a>) and the Google Privacy Policy
        (<a className="underline" href="https://policies.google.com/privacy">policies.google.com/privacy</a>).
      </p>
    </main>
  );
}
