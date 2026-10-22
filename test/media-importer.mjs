import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createMediaImporter } from "../src/PiDesktop.Tauri/electron/services/media-importer.ts";

const testRoot = await mkdtemp(join(tmpdir(), "media-importer-test-"));
const fakeModuleRoot = join(testRoot, "fake-python");
const fakePackage = join(fakeModuleRoot, "yt_dlp");
const fixtureWave = join(testRoot, "source.wav");
const badFixture = join(testRoot, "not-a-wave.bin");
const childMarker = join(testRoot, "cancelled-child-survived");
const mediaRoot = join(testRoot, "managed-data");
const videoUrl = "https://www.bilibili.com/video/BV1QQ4y1E73r/?p=2";
const ffmpegPath = process.env.FFMPEG_PATH ?? "ffmpeg";
const ffmpegAvailable = spawnSync(ffmpegPath, ["-version"], { stdio: "ignore" }).status === 0;
const previousPythonPath = process.env.PYTHONPATH;
const previousFixture = process.env.MEDIA_IMPORT_FIXTURE_WAV;
const previousMode = process.env.MEDIA_IMPORT_TEST_MODE;
const previousFakeId = process.env.MEDIA_IMPORT_TEST_ID;
const previousFakeWebpage = process.env.MEDIA_IMPORT_TEST_WEBPAGE;
const previousChildMarker = process.env.MEDIA_IMPORT_CHILD_MARKER;

function createWave() {
  const sampleRate = 8000;
  const sampleCount = sampleRate;
  const data = Buffer.alloc(44 + sampleCount * 2);
  data.write("RIFF", 0, "ascii");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8, "ascii");
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24);
  data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36, "ascii");
  data.writeUInt32LE(sampleCount * 2, 40);
  for (let index = 0; index < sampleCount; index += 1) data.writeInt16LE(Math.round(Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 9000), 44 + index * 2);
  return data;
}

try {
  await mkdir(fakePackage, { recursive: true });
  await writeFile(fixtureWave, createWave());
  await writeFile(badFixture, "not media");
  await writeFile(join(fakePackage, "__init__.py"), "");
  await writeFile(join(fakePackage, "__main__.py"), `
import json, os, shutil, subprocess, sys, time
assert "--no-cache-dir" in sys.argv
assert "--ignore-config" in sys.argv
assert "--no-playlist" in sys.argv
assert not any("cookie" in argument.lower() for argument in sys.argv)
assert "--download-sections" not in sys.argv
video = {
  "id": os.environ.get("MEDIA_IMPORT_TEST_ID", "BV1QQ4y1E73r"),
  "title": "Fixture video",
  "uploader": "Fixture uploader",
  "duration": 1,
  "thumbnail": "https://i.example.test/fixture.jpg",
  "webpage_url": os.environ.get("MEDIA_IMPORT_TEST_WEBPAGE", "https://www.bilibili.com/video/BV1QQ4y1E73r/"),
}
if "--dump-single-json" in sys.argv:
  print(json.dumps(video, ensure_ascii=False))
else:
  if os.environ.get("MEDIA_IMPORT_TEST_MODE") == "wait":
    child_code = "import os, pathlib, time; time.sleep(1.2); pathlib.Path(os.environ['MEDIA_IMPORT_CHILD_MARKER']).write_text('survived')"
    subprocess.Popen([sys.executable, "-c", child_code])
    print("[download] 1.0%", file=sys.stderr, flush=True)
    time.sleep(30)
  output = sys.argv[sys.argv.index("--output") + 1].replace("%(ext)s", "wav")
  shutil.copyfile(os.environ["MEDIA_IMPORT_FIXTURE_WAV"], output)
  print("[download] 100.0%", file=sys.stderr, flush=True)
`);
  // yt_dlp is faked through PYTHONPATH, so any interpreter works; a local audio venv is used when there is one.
  const venvPython = "/private/tmp/synthv-audio-venv/bin/python";
  const systemPython = process.platform === "win32" ? "python" : "python3";
  const python = process.env.MEDIA_IMPORT_TEST_PYTHON ?? await access(venvPython).then(() => venvPython, () => systemPython);
  process.env.PYTHONPATH = [fakeModuleRoot, previousPythonPath].filter(Boolean).join(delimiter);
  process.env.MEDIA_IMPORT_FIXTURE_WAV = fixtureWave;
  process.env.MEDIA_IMPORT_TEST_MODE = "normal";
  process.env.MEDIA_IMPORT_CHILD_MARKER = childMarker;
  const importer = createMediaImporter({ dataRoot: mediaRoot, python, ffmpegPath });

  const missingPython = createMediaImporter({ dataRoot: join(testRoot, "missing-python-data"), python: join(testRoot, "missing-python") });
  await assert.rejects(missingPython.preview("https://www.bilibili.com/video/BV1QQ4y1E73r/"), /Python executable was not found/u);
  const fakePythonPath = process.env.PYTHONPATH;
  process.env.PYTHONPATH = join(testRoot, "no-python-modules");
  const missingYtDlp = createMediaImporter({ dataRoot: join(testRoot, "missing-ytdlp-data"), python: systemPython });
  await assert.rejects(missingYtDlp.preview("https://www.bilibili.com/video/BV1QQ4y1E73r/"), /yt-dlp is not installed/u);
  process.env.PYTHONPATH = fakePythonPath;
  await assert.rejects(importer.preview("http://www.bilibili.com/video/BV1QQ4y1E73r/"), /HTTPS/u);
  await assert.rejects(importer.preview("https://example.com/video/BV1QQ4y1E73r/"), /Supported sources/u);
  await assert.rejects(importer.preview("https://www.bilibili.com/video/BV1QQ4y1E73r/?p=0"), /valid single Bilibili/u);
  await assert.rejects(importer.importSource(videoUrl, { rightsConfirmed: false }), /rights/u);

  const preview = await importer.preview(videoUrl);
  assert.deepEqual(preview, {
    sourceUrl: videoUrl,
    canonicalUrl: "https://www.bilibili.com/video/BV1QQ4y1E73r/?p=2",
    platform: "bilibili",
    mediaId: "BV1QQ4y1E73r",
    title: "Fixture video",
    uploader: "Fixture uploader",
    durationSeconds: 1,
    thumbnailUrl: "https://i.example.test/fixture.jpg",
  });

  process.env.MEDIA_IMPORT_TEST_ID = "dQw4w9WgXcQ";
  process.env.MEDIA_IMPORT_TEST_WEBPAGE = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const youtubePreview = await importer.preview("https://youtu.be/dQw4w9WgXcQ");
  assert.equal(youtubePreview.platform, "youtube");
  assert.equal(youtubePreview.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  delete process.env.MEDIA_IMPORT_TEST_ID;
  delete process.env.MEDIA_IMPORT_TEST_WEBPAGE;

  const linkRoot = join(testRoot, "symlink-output");
  const linkTarget = join(testRoot, "outside-media");
  await mkdir(linkRoot, { recursive: true });
  await mkdir(linkTarget, { recursive: true });
  await symlink(linkTarget, join(linkRoot, "media"));
  const linkImporter = createMediaImporter({ dataRoot: linkRoot, python, ffmpegPath });
  await assert.rejects(linkImporter.importSource(videoUrl, { rightsConfirmed: true }), /symbolic link/u);

  // Conversion runs the real FFmpeg; CI runners have none, so that part is reported as skipped rather than failing the chain.
  if (!ffmpegAvailable) console.log(`Media import conversion not executed: FFmpeg is not available at ${ffmpegPath}. Set FFMPEG_PATH to run it.`);
  else {
    const progress = [];
    const imported = await importer.importSource(videoUrl, {
      rightsConfirmed: true,
      onProgress: (value, detail) => progress.push({ value, detail }),
    });
    assert.equal(imported.source.canonicalUrl, preview.canonicalUrl);
    assert.match(imported.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(createHash("sha256").update(await readFile(imported.audioPath)).digest("hex"), imported.sha256);
    assert.deepEqual((await readFile(imported.audioPath)).subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(JSON.parse(await readFile(imported.metadataPath, "utf8")).title, "Fixture video");
    const manifest = JSON.parse(await readFile(imported.manifestPath, "utf8"));
    assert.equal(manifest.rightsConfirmed, true);
    assert.match(manifest.rightsConfirmedAtUtc, /^\d{4}-\d\d-\d\dT.*Z$/u);
    assert.equal(manifest.sha256, imported.sha256);
    assert.equal(manifest.source.canonicalUrl, preview.canonicalUrl);
    assert.ok(progress.some((item) => item.detail.includes("Downloading")));
    assert.equal(progress.at(-1).value, 100);
    const secondImport = await importer.importSource(videoUrl, { rightsConfirmed: true });
    assert.notEqual(secondImport.importId, imported.importId);
    assert.notEqual(secondImport.audioPath, imported.audioPath);

    const mediaDirectory = join(mediaRoot, "media");
    const publishedDirectory = join(mediaDirectory, imported.importId);
    assert.deepEqual((await readdir(publishedDirectory)).sort(), ["audio.wav", "manifest.json", "metadata.json"]);
    assert.ok((await readdir(mediaDirectory)).every((name) => !name.startsWith(".staging-")));

    const aborter = new AbortController();
    process.env.MEDIA_IMPORT_TEST_MODE = "wait";
    const cancelledImport = importer.importSource(videoUrl, {
      rightsConfirmed: true,
      signal: aborter.signal,
      onProgress: (value, detail) => {
        if (value > 8 && detail.includes("Downloading")) aborter.abort();
      },
    });
    await assert.rejects(cancelledImport, { name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await assert.rejects(readFile(childMarker), { code: "ENOENT" });
    assert.deepEqual((await readdir(mediaDirectory)).filter((name) => name.startsWith(".staging-")), []);
    assert.ok((await readdir(mediaDirectory)).includes(imported.importId));

    process.env.MEDIA_IMPORT_TEST_MODE = "normal";
    process.env.MEDIA_IMPORT_FIXTURE_WAV = badFixture;
    await assert.rejects(importer.importSource(videoUrl, { rightsConfirmed: true }), /ffmpeg failed/u);
    assert.deepEqual((await readdir(mediaDirectory)).filter((name) => name.startsWith(".staging-")), []);
  }
} finally {
  if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = previousPythonPath;
  if (previousFixture === undefined) delete process.env.MEDIA_IMPORT_FIXTURE_WAV;
  else process.env.MEDIA_IMPORT_FIXTURE_WAV = previousFixture;
  if (previousMode === undefined) delete process.env.MEDIA_IMPORT_TEST_MODE;
  else process.env.MEDIA_IMPORT_TEST_MODE = previousMode;
  if (previousFakeId === undefined) delete process.env.MEDIA_IMPORT_TEST_ID;
  else process.env.MEDIA_IMPORT_TEST_ID = previousFakeId;
  if (previousFakeWebpage === undefined) delete process.env.MEDIA_IMPORT_TEST_WEBPAGE;
  else process.env.MEDIA_IMPORT_TEST_WEBPAGE = previousFakeWebpage;
  if (previousChildMarker === undefined) delete process.env.MEDIA_IMPORT_CHILD_MARKER;
  else process.env.MEDIA_IMPORT_CHILD_MARKER = previousChildMarker;
  await rm(testRoot, { recursive: true, force: true });
}

console.log(ffmpegAvailable ? "Media importer preview, full WAV conversion, manifest, cancellation, and failure contracts passed." : "Media importer preview, validation and symlink contracts passed.");
