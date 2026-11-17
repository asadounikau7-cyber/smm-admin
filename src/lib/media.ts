import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export type ProbeResult = {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
};

export function run(cmd: string, args: string[], timeoutMs = 120_000, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** ffprobe reads only the headers it needs via HTTP range requests; the file is not downloaded. */
export async function probe(url: string): Promise<ProbeResult> {
  const r = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", url]);
  if (r.code !== 0) throw new Error(`ffprobe: ${r.stderr.slice(0, 300)}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const a = j.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
  let width = v?.width ?? null;
  let height = v?.height ?? null;
  const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((s: { rotation?: number }) => s.rotation !== undefined)?.rotation ?? 0);
  if (Math.abs(rot) === 90 || Math.abs(rot) === 270) [width, height] = [height, width];
  return {
    durationSec: j.format?.duration ? Number(j.format.duration) : null,
    width,
    height,
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
  };
}

/** Grabs a frame and overlays a title: a cheap generated cover. Returns a JPEG buffer. */
export async function generateCover(videoUrl: string, title: string, atSec = 1, vertical = true): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "cover-"));
  const out = path.join(dir, "cover.jpg");
  const safe = title.replace(/[\\:'%]/g, " ").slice(0, 60);
  const size = vertical ? "1080:1920" : "1280:720";
  const vf = [
    `scale=${size}:force_original_aspect_ratio=increase`,
    `crop=${size}`,
    `drawbox=y=ih*0.72:w=iw:h=ih*0.16:color=black@0.45:t=fill`,
    `drawtext=text='${safe}':fontcolor=white:fontsize=h/22:x=(w-text_w)/2:y=h*0.8-text_h/2`,
  ].join(",");
  try {
    const r = await run("ffmpeg", ["-y", "-ss", String(atSec), "-i", videoUrl, "-frames:v", "1", "-vf", vf, "-q:v", "3", out]);
    if (r.code !== 0) throw new Error(`ffmpeg cover: ${r.stderr.slice(-300)}`);
    return await readFile(out);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Transcodes into a platform-safe 9:16 H.264/AAC MP4 (for teasers that don't pass validation). */
export async function transcodeVertical(inputUrl: string, outPath: string, maxSec?: number) {
  const args = ["-y", "-i", inputUrl];
  if (maxSec) args.push("-t", String(maxSec));
  args.push(
    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30",
    "-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "21",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000",
    "-movflags", "+faststart",
    outPath,
  );
  const r = await run("ffmpeg", args, 30 * 60_000);
  if (r.code !== 0) throw new Error(`ffmpeg transcode: ${r.stderr.slice(-300)}`);
}
