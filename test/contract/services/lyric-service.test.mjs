import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLyricService, LYRIC_COMMANDS } from "../../../src/PiDesktop.Tauri/electron/services/lyric-service.ts";

const root = await mkdtemp(join(tmpdir(), "lyric-service-"));
const service = createLyricService(root);
const section = { id: "chorus", kind: "chorus", label: "副歌", lineCount: 2, rhymeScheme: "AB" };

try {
  assert.deepEqual(LYRIC_COMMANDS, [
    "create_lyric_project", "save_lyric_project", "load_lyric_project", "list_lyric_projects",
    "restore_lyric_project_version", "export_lyric_project_text", "build_lyric_template", "lookup_chinese_rhyme",
  ]);

  const created = await service.invoke("create_lyric_project", {
    title: "月光下",
    draft: "第一句\n第二句",
    sections: [section],
    rhymeTargets: { A: "ang" },
    candidateHistory: [],
  });
  assert.equal(created.schemaVersion, 1);
  assert.equal(created.revision, 1);
  assert.match(created.createdAtUtc, /^\d{4}-\d\d-\d\dT.*Z$/u);
  const createdStorage = JSON.parse(await readFile(join(root, "lyrics", "projects.json"), "utf8"))[0];
  assert.equal(createdStorage.schemaVersion, undefined);
  assert.equal(createdStorage.createdAt, created.createdAtUtc);
  assert.equal(createdStorage.createdAtUtc, undefined);

  const saved = await service.invoke("save_lyric_project", {
    id: created.id,
    title: "月光下修订",
    draft: "新的歌词",
    sections: [section],
    rhymeTargets: { A: "ing" },
    candidateHistory: Array.from({ length: 20 }, (_, index) => ({
      language: "zh-CN", brief: `brief-${index}`, imagery: "", sectionLabel: "副歌", targetRhyme: null, candidates: [],
    })),
  });
  assert.equal(saved.revision, 2);
  assert.equal(saved.versions.length, 1);
  assert.equal(saved.candidateHistory.length, 20);
  const savedStorage = JSON.parse(await readFile(join(root, "lyrics", "projects.json"), "utf8"))[0];
  assert.equal(savedStorage.updatedAt, saved.updatedAtUtc);
  assert.equal(savedStorage.versions[0].savedAt, saved.versions[0].savedAtUtc);
  assert.equal(savedStorage.versions[0].savedAtUtc, undefined);

  const restarted = createLyricService(root);
  assert.equal((await restarted.invoke("load_lyric_project", { id: created.id })).draft, "新的歌词");
  assert.deepEqual(await restarted.invoke("list_lyric_projects", {}), [{
    id: created.id,
    title: "月光下修订",
    revision: 2,
    lineCount: 1,
    updatedAtUtc: saved.updatedAtUtc,
  }]);

  const restored = await restarted.invoke("restore_lyric_project_version", { id: created.id, revision: 1 });
  assert.equal(restored.revision, 3);
  assert.equal(restored.draft, "第一句\n第二句");
  assert.equal(restored.versions.length, 2);
  assert.equal((await createLyricService(root).invoke("load_lyric_project", { id: created.id })).draft, "第一句\n第二句");

  const legacyRoot = await mkdtemp(join(tmpdir(), "lyric-legacy-"));
  await mkdir(join(legacyRoot, "lyrics"), { recursive: true });
  const legacyProject = {
    id: "legacy-project",
    title: "旧格式项目",
    draft: "旧格式正文",
    rhymeTargets: { A: "ang" },
    sections: [section],
    candidateHistory: [],
    versions: [{ revision: 1, title: "旧版", draft: "旧稿", rhymeTargets: {}, sections: [], candidateHistory: [], savedAt: "2025-01-02T03:04:05.000Z" }],
    revision: 2,
    createdAt: "2025-01-01T03:04:05.000Z",
    updatedAt: "2025-01-02T03:04:05.000Z",
  };
  const legacyPath = join(legacyRoot, "lyrics", "projects.json");
  await writeFile(legacyPath, JSON.stringify([legacyProject]));
  const legacyService = createLyricService(legacyRoot);
  const legacyLoaded = await legacyService.invoke("load_lyric_project", { id: legacyProject.id });
  assert.equal(legacyLoaded.schemaVersion, 1);
  assert.equal(legacyLoaded.createdAtUtc, legacyProject.createdAt);
  assert.equal(legacyLoaded.updatedAtUtc, legacyProject.updatedAt);
  assert.equal(legacyLoaded.versions[0].savedAtUtc, legacyProject.versions[0].savedAt);
  await legacyService.invoke("save_lyric_project", { id: legacyProject.id, draft: "保存后的旧格式" });
  const legacySavedOnDisk = JSON.parse(await readFile(legacyPath, "utf8"))[0];
  assert.equal(legacySavedOnDisk.createdAt, legacyProject.createdAt);
  assert.equal(legacySavedOnDisk.createdAtUtc, undefined);
  assert.equal(legacySavedOnDisk.versions.some((version) => "savedAt" in version && !("savedAtUtc" in version)), true);
  assert.equal((await createLyricService(legacyRoot).invoke("load_lyric_project", { id: legacyProject.id })).draft, "保存后的旧格式");
  await rm(legacyRoot, { recursive: true, force: true });

  const sizeRoot = await mkdtemp(join(tmpdir(), "lyric-size-"));
  await mkdir(join(sizeRoot, "lyrics"), { recursive: true });
  const fullCandidateHistory = Array.from({ length: 20 }, (_, setIndex) => ({
    language: "zh-CN",
    brief: `b${setIndex}`.padEnd(512, "b"),
    imagery: "i".repeat(512),
    sectionLabel: "s".repeat(512),
    targetRhyme: null,
    candidates: Array.from({ length: 20 }, (_, candidateIndex) => ({ text: `t${candidateIndex}`.padEnd(512, "t"), note: "n".repeat(256) })),
  }));
  const largeLegacy = {
    ...legacyProject,
    id: "large-legacy-project",
    revision: 31,
    draft: "active",
    candidateHistory: fullCandidateHistory,
    versions: Array.from({ length: 30 }, (_, index) => ({
      revision: index + 1,
      title: `旧版 ${index + 1}`,
      draft: String(index + 1).padEnd(700_000, "x"),
      rhymeTargets: {},
      sections: [],
      candidateHistory: fullCandidateHistory,
      savedAt: new Date(Date.UTC(2020, 0, index + 1)).toISOString(),
    })),
  };
  const largePath = join(sizeRoot, "lyrics", "projects.json");
  await writeFile(largePath, JSON.stringify([largeLegacy]));
  const sizeService = createLyricService(sizeRoot);
  await sizeService.invoke("save_lyric_project", { id: largeLegacy.id, draft: "短正文" });
  const boundedStorage = JSON.parse(await readFile(largePath, "utf8"))[0];
  assert.ok(boundedStorage.versions.length < 30);
  assert.ok(boundedStorage.versions.some((version) => version.revision === 31));
  assert.ok((await stat(largePath)).size <= 16 * 1024 * 1024);
  await rm(sizeRoot, { recursive: true, force: true });

  await Promise.all([
    restarted.invoke("save_lyric_project", { id: created.id, draft: "并发写入 A" }),
    restarted.invoke("save_lyric_project", { id: created.id, draft: "并发写入 B" }),
  ]);
  const concurrent = await restarted.invoke("load_lyric_project", { id: created.id });
  assert.equal(concurrent.revision, 5);
  assert.equal(concurrent.draft, "并发写入 B");
  assert.equal(concurrent.versions.length, 4);
  for (let index = 0; index < 32; index += 1) {
    await restarted.invoke("save_lyric_project", { id: created.id, draft: `版本 ${index}` });
  }
  assert.equal((await restarted.invoke("load_lyric_project", { id: created.id })).versions.length, 30);

  const umlaut = await service.invoke("lookup_chinese_rhyme", { query: "lǜ", matchMode: "exact" });
  assert.ok(umlaut.characters.some(item => item.character === "绿"));
  assert.ok(!umlaut.characters.some(item => item.character === "路"));

  const template = await service.invoke("build_lyric_template", {
    language: "zh-CN", title: "夜行", sections: [section], rhymeTargets: { A: "ang", B: "ing" },
  });
  assert.equal(template.kind, "lyric-template");
  assert.equal(template.data.totalLines, 2);
  assert.equal(template.data.sections[0].id, "chorus");
  assert.equal(template.data.sections[0].lines[0].rhymeLabel, "A");
  assert.equal(template.data.sections[0].lines[0].targetRhyme, "ang");
  assert.equal(template.data.sections[0].lines[1].placeholder, "副歌 第 2 句 · B 韵");

  const exported = await service.invoke("export_lyric_project_text", { title: "月光下", draft: "月光照着我 🌙" });
  assert.equal(await readFile(exported.detail, "utf8"), "月光照着我 🌙");
  const exportedAgain = await service.invoke("export_lyric_project_text", { title: "月光下", draft: "新的副本" });
  assert.notEqual(exportedAgain.detail, exported.detail);
  assert.equal(await readFile(exportedAgain.detail, "utf8"), "新的副本");
  assert.equal(await readFile(exported.detail, "utf8"), "月光照着我 🌙");

  const polyphonic = await service.invoke("lookup_chinese_rhyme", { query: "行", matchMode: "exact" });
  assert.deepEqual(polyphonic.queryPinyin, ["hang", "heng", "xing"]);
  assert.deepEqual(polyphonic.rhymeKeys, ["ang", "eng", "ing"]);
  assert.ok(polyphonic.characters.some((item) => item.character === "行" && item.pinyin.includes("xing")));

  const pinyin = await service.invoke("lookup_chinese_rhyme", { query: "xing", matchMode: "exact" });
  assert.deepEqual(pinyin.queryPinyin, ["xing"]);
  assert.deepEqual(pinyin.rhymeKeys, ["ing"]);
  assert.ok(pinyin.characters.some((item) => item.character === "行"));
  const family = await service.invoke("lookup_chinese_rhyme", { query: "guang", matchMode: "family" });
  assert.ok(family.rhymeKeys.includes("ang"));
  assert.ok(family.characters.some((item) => item.character === "行" && item.pinyin.includes("hang")));

  await assert.rejects(service.invoke("create_lyric_project", { title: "bad", sections: [{ ...section, lineCount: -1 }] }), /lineCount/u);
  await assert.rejects(service.invoke("lookup_chinese_rhyme", { query: "  " }), /query/u);
  await assert.rejects(service.invoke("lookup_chinese_rhyme", { query: "abc", matchMode: "near" }), /matchMode/u);
  await assert.rejects(service.invoke("build_lyric_template", { language: "en-US", sections: [] }), /zh-CN/u);
  await assert.rejects(service.invoke("create_lyric_project", { title: "bad", candidateHistory: [{ brief: "malformed" }] }), /candidateHistory/u);
  await assert.rejects(service.invoke("create_lyric_project", { title: "bad", candidateHistory: Array.from({ length: 21 }, () => ({ language: "zh-CN", brief: "", imagery: "", sectionLabel: "", candidates: [] })) }), /at most 20/u);
  await assert.rejects(service.invoke("create_lyric_project", { title: "bad", draft: "x".repeat(1_000_001) }), /draft/u);
  await assert.rejects(service.invoke("not_a_lyric_command", {}), /Unsupported lyric command/u);

  const outside = await mkdtemp(join(tmpdir(), "lyric-outside-"));
  await rm(join(root, "lyrics", "exports"), { recursive: true, force: true });
  await symlink(outside, join(root, "lyrics", "exports"));
  await assert.rejects(service.invoke("export_lyric_project_text", { title: "escape", draft: "x" }), /escapes/u);
  await rm(outside, { recursive: true, force: true });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Lyric service persistence, template, rhyme, and input-boundary contracts passed.");
