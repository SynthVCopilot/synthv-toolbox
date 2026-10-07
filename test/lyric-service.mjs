import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLyricService, LYRIC_COMMANDS } from "../src/PiDesktop.Tauri/electron/services/lyric-service.ts";

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

  const saved = await service.invoke("save_lyric_project", {
    id: created.id,
    title: "月光下修订",
    draft: "新的歌词",
    sections: [section],
    rhymeTargets: { A: "ing" },
    candidateHistory: Array.from({ length: 25 }, (_, index) => ({
      language: "zh-CN", brief: `brief-${index}`, imagery: "", sectionLabel: "副歌", targetRhyme: null, candidates: [],
    })),
  });
  assert.equal(saved.revision, 2);
  assert.equal(saved.versions.length, 1);
  assert.equal(saved.candidateHistory.length, 20);

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
  await assert.rejects(service.invoke("export_lyric_project_text", { title: "月光下", draft: "不可覆盖" }), /EEXIST/u);
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
