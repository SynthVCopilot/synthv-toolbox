import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { polyphonic } from "pinyin-pro";

type Args = Record<string, unknown>;
type RhymeEntry = { character: string; pinyin: string[]; finals: string[]; families: string[] };
type RhymeMatchMode = "family" | "exact";
type LyricSectionRequest = { id: string; kind: "intro" | "verse" | "preChorus" | "chorus" | "bridge" | "instrumental" | "outro" | "custom"; label: string; lineCount: number; rhymeScheme: string };
type LyricCandidateSet = { language: "zh-CN"; brief: string; imagery: string; sectionLabel: string; targetRhyme?: string | null; candidates: Array<{ text: string; rhymeFoot?: string | null; rhymeMatched?: boolean | null; note: string }> };
type LyricProjectVersion = { revision: number; title: string; draft: string; rhymeTargets: Record<string, string>; sections: LyricSectionRequest[]; candidateHistory: LyricCandidateSet[]; savedAtUtc: string };
type LyricProject = { schemaVersion: number; id: string; title: string; draft: string; rhymeTargets: Record<string, string>; sections: LyricSectionRequest[]; candidateHistory: LyricCandidateSet[]; versions: LyricProjectVersion[]; revision: number; createdAtUtc: string; updatedAtUtc: string };
type LyricProjectSummary = { id: string; title: string; revision: number; lineCount: number; updatedAtUtc: string };
type ChineseRhymeLookup = { language: "zh-CN"; query: string; queryPinyin: string[]; matchMode: RhymeMatchMode; rhymeKeys: string[]; total: number; characters: Array<{ character: string; pinyin: string[] }>; coverageNote: string };

export const LYRIC_COMMANDS = [
  "create_lyric_project",
  "save_lyric_project",
  "load_lyric_project",
  "list_lyric_projects",
  "restore_lyric_project_version",
  "export_lyric_project_text",
  "build_lyric_template",
  "lookup_chinese_rhyme",
] as const;

export interface LyricService {
  invoke(command: string, args: Args): Promise<unknown>;
}

export function createLyricService(dataRoot: string): LyricService {
  const requestedRoot = resolve(dataRoot);
  let mutationQueue: Promise<unknown> = Promise.resolve();
  let rhymeIndexPromise: Promise<RhymeEntry[]> | undefined;

  const serializeMutation = <T>(action: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(action, action);
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const ensureRoot = async () => {
    await mkdir(requestedRoot, { recursive: true });
    return realpath(requestedRoot);
  };

  const assertInsideRoot = (root: string, path: string) => {
    const pathFromRoot = relative(root, path);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(path) === root) {
      throw new Error("Lyric data path escapes the data root.");
    }
  };

  const assertNoEscapingSymlink = async (path: string, root: string, includeLeaf: boolean) => {
    let current = includeLeaf ? path : dirname(path);
    while (current !== root && current !== dirname(current)) {
      try {
        await stat(current);
        const canonical = await realpath(current);
        assertInsideRoot(root, canonical);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      current = dirname(current);
    }
    if (current !== root) throw new Error("Lyric data path escapes the data root.");
  };

  const projectFile = async () => {
    const root = await ensureRoot();
    const projectsPath = join(root, "lyrics", "projects.json");
    await mkdir(dirname(projectsPath), { recursive: true });
    await assertNoEscapingSymlink(dirname(projectsPath), root, true);
    await assertNoEscapingSymlink(projectsPath, root, true);
    return { root, path: projectsPath };
  };

  const writeAtomic = async (path: string, value: unknown) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  const readProjects = async (): Promise<LyricProject[]> => {
    const { path } = await projectFile();
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const projects: unknown = JSON.parse(source);
    if (!Array.isArray(projects)) throw new Error("Lyric project storage must contain an array.");
    return projects.map(validateStoredProject);
  };

  const saveProjects = async (projects: LyricProject[]) => {
    const { root, path } = await projectFile();
    await assertNoEscapingSymlink(path, root, true);
    await writeAtomic(path, projects);
  };

  const now = () => new Date().toISOString();
  const asString = (value: unknown, field: string, fallback?: string) => {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value !== "string") throw new Error(`${field} must be a string.`);
    return value;
  };
  const bounded = (value: string, maxLength: number, field: string) => {
    if (value.length > maxLength) throw new Error(`${field} must contain at most ${maxLength} characters.`);
    return value;
  };
  const clone = <T>(value: T): T => structuredClone(value);
  const cleanSections = (value: unknown): LyricSectionRequest[] => {
    if (!Array.isArray(value)) throw new Error("sections must be an array.");
    if (value.length > 32) throw new Error("sections must contain at most 32 items.");
    return value.map((item, index) => {
      if (!item || typeof item !== "object") throw new Error(`sections[${index}] must be an object.`);
      const section = item as Record<string, unknown>;
      const lineCount = Number(section.lineCount);
      if (!Number.isSafeInteger(lineCount) || lineCount < 0 || lineCount > 256) throw new Error(`sections[${index}].lineCount must be between 0 and 256.`);
      if (typeof section.rhymeScheme !== "string") throw new Error(`sections[${index}].rhymeScheme must be a string.`);
      const kind = asString(section.kind, `sections[${index}].kind`);
      if (!["intro", "verse", "preChorus", "chorus", "bridge", "instrumental", "outro", "custom"].includes(kind)) throw new Error(`sections[${index}].kind is invalid.`);
      return {
        id: asString(section.id, `sections[${index}].id`),
        kind: kind as LyricSectionRequest["kind"],
        label: asString(section.label, `sections[${index}].label`),
        lineCount,
        rhymeScheme: section.rhymeScheme,
      };
    });
  };
  const cleanStringRecord = (value: unknown, field: string): Record<string, string> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 128 || entries.some(([key, item]) => key.length > 64 || typeof item !== "string" || item.length > 128)) throw new Error(`${field} contains invalid or excessive entries.`);
    return Object.fromEntries(entries) as Record<string, string>;
  };
  const cleanCandidateHistory = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error("candidateHistory must be an array.");
    if (value.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const set = item as Record<string, unknown>;
      if (set.language !== "zh-CN" || typeof set.brief !== "string" || typeof set.imagery !== "string" || typeof set.sectionLabel !== "string" || !Array.isArray(set.candidates)) return true;
      if (set.targetRhyme !== undefined && set.targetRhyme !== null && typeof set.targetRhyme !== "string") return true;
      return set.candidates.some((candidate) => !candidate || typeof candidate !== "object" || Array.isArray(candidate) || typeof (candidate as Record<string, unknown>).text !== "string" || typeof (candidate as Record<string, unknown>).note !== "string");
    })) throw new Error("candidateHistory contains an invalid candidate set.");
    return clone(value.slice(-20)) as LyricCandidateSet[];
  };
  const validateStoredProject = (value: unknown): LyricProject => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Stored lyric project must be an object.");
    const project = value as Record<string, unknown>;
    if (project.schemaVersion !== 1) throw new Error("Unsupported lyric project schema version.");
    const revision = Number(project.revision);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Stored lyric project has an invalid revision.");
    if (!Array.isArray(project.versions) || project.versions.some((item) => !item || typeof item !== "object")) throw new Error("Stored lyric project versions are invalid.");
    const validVersions = project.versions.map((item) => {
      const version = item as Record<string, unknown>;
      const versionRevision = Number(version.revision);
      if (!Number.isSafeInteger(versionRevision) || versionRevision < 1) throw new Error("Stored lyric project version has an invalid revision.");
      return {
        revision: versionRevision,
        title: asString(version.title, "version.title"),
        draft: asString(version.draft, "version.draft"),
        rhymeTargets: cleanStringRecord(version.rhymeTargets, "version.rhymeTargets"),
        sections: cleanSections(version.sections),
        candidateHistory: cleanCandidateHistory(version.candidateHistory),
        savedAtUtc: asString(version.savedAtUtc, "version.savedAtUtc"),
      } satisfies LyricProjectVersion;
    }).slice(-30);
    return {
      schemaVersion: 1,
      id: asString(project.id, "id"),
      title: asString(project.title, "title"),
      draft: asString(project.draft, "draft"),
      rhymeTargets: cleanStringRecord(project.rhymeTargets, "rhymeTargets"),
      sections: cleanSections(project.sections),
      candidateHistory: cleanCandidateHistory(project.candidateHistory),
      versions: validVersions,
      revision,
      createdAtUtc: asString(project.createdAtUtc, "createdAtUtc"),
      updatedAtUtc: asString(project.updatedAtUtc, "updatedAtUtc"),
    };
  };

  const projectVersion = (project: LyricProject): LyricProjectVersion => ({
    revision: project.revision,
    title: project.title,
    draft: project.draft,
    rhymeTargets: clone(project.rhymeTargets),
    sections: clone(project.sections),
    candidateHistory: clone(project.candidateHistory),
    savedAtUtc: project.updatedAtUtc,
  });

  const makeProject = (args: Args): LyricProject => {
    const timestamp = now();
    return {
      schemaVersion: 1,
      id: randomUUID(),
      title: bounded(asString(args.title, "title", "未命名歌曲"), 256, "title").trim() || "未命名歌曲",
      draft: bounded(asString(args.draft, "draft", ""), 1_000_000, "draft"),
      rhymeTargets: args.rhymeTargets === undefined ? {} : cleanStringRecord(args.rhymeTargets, "rhymeTargets"),
      sections: args.sections === undefined ? [] : cleanSections(args.sections),
      candidateHistory: args.candidateHistory === undefined ? [] : cleanCandidateHistory(args.candidateHistory),
      versions: [],
      revision: 1,
      createdAtUtc: timestamp,
      updatedAtUtc: timestamp,
    };
  };

  const updateProject = (existing: LyricProject, args: Args, restoredVersion?: LyricProjectVersion): LyricProject => {
    const source = restoredVersion ?? {
      title: bounded(asString(args.title, "title", existing.title), 256, "title").trim() || "未命名歌曲",
      draft: bounded(asString(args.draft, "draft", existing.draft), 1_000_000, "draft"),
      rhymeTargets: args.rhymeTargets === undefined ? existing.rhymeTargets : cleanStringRecord(args.rhymeTargets, "rhymeTargets"),
      sections: args.sections === undefined ? existing.sections : cleanSections(args.sections),
      candidateHistory: args.candidateHistory === undefined ? existing.candidateHistory : cleanCandidateHistory(args.candidateHistory),
    };
    return {
      schemaVersion: 1,
      id: existing.id,
      title: source.title,
      draft: source.draft,
      rhymeTargets: clone(source.rhymeTargets),
      sections: clone(source.sections),
      candidateHistory: clone(source.candidateHistory).slice(-20),
      versions: [...existing.versions, projectVersion(existing)].slice(-30),
      revision: existing.revision + 1,
      createdAtUtc: existing.createdAtUtc,
      updatedAtUtc: now(),
    };
  };

  const listProjects = async (args: Args): Promise<LyricProjectSummary[]> => {
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer between 1 and 200.");
    return (await readProjects())
      .map((project) => ({
        id: project.id,
        title: project.title,
        revision: project.revision,
        lineCount: project.draft.split(/\r?\n/u).filter((line) => line.trim()).length,
        updatedAtUtc: project.updatedAtUtc,
      }))
      .sort((left, right) => right.updatedAtUtc.localeCompare(left.updatedAtUtc))
      .slice(0, limit);
  };

  const buildTemplate = (args: Args) => {
    if (args.language !== "zh-CN") throw new Error("Only zh-CN lyric templates are supported.");
    const sections = cleanSections(args.sections);
    const rhymeTargets = cleanStringRecord(args.rhymeTargets ?? {}, "rhymeTargets");
    const title = asString(args.title, "title", "未命名歌曲").trim() || "未命名歌曲";
    const built = sections.map((section) => ({
      ...section,
      lines: Array.from({ length: section.lineCount }, (_, index) => {
        const scheme = section.rhymeScheme || "-";
        const marker = scheme[index % scheme.length]?.toUpperCase() ?? "-";
        return {
          lineNumber: index + 1,
          rhymeLabel: marker === "-" ? null : marker,
          targetRhyme: marker === "-" ? null : rhymeTargets[marker] ?? null,
          placeholder: `${section.label} 第 ${index + 1} 句${marker === "-" ? "" : ` · ${marker} 韵`}`,
        };
      }),
    }));
    const totalLines = built.reduce((sum, section) => sum + section.lines.length, 0);
    return {
      kind: "lyric-template",
      summary: `已建立《${title}》的歌词结构：${sections.length} 个段落，共 ${totalLines} 行。`,
      data: { language: "zh-CN", title, totalLines, rhymeTargets, sections: built },
    };
  };

  const removeToneMarks = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/gu, "").replace(/ü/giu, "v").toLowerCase();
  const classifyFinal = (final: string) => {
    const normalized = removeToneMarks(final);
    const match = normalized.match(/(ang|eng|ong|an|en|un|in|ao|ou|ai|ei|ia|ie|iao|iu|ua|uo|uai|ui|ue|ve|a|o|e|i|u|v)$/u);
    return match?.[1] ?? normalized;
  };

  const getRhymeIndex = () => {
    if (!rhymeIndexPromise) {
      rhymeIndexPromise = Promise.resolve().then(() => {
        const characters = Array.from({ length: 0x9fff - 0x3400 + 1 }, (_, index) => String.fromCodePoint(index + 0x3400));
        const pronunciationData = polyphonic(characters.join(""), { type: "all", toneType: "none" }) as Array<Array<{ pinyin: string; final: string; isZh: boolean }>>;
        return characters.flatMap((character, index) => {
          const pronunciations = pronunciationData[index] ?? [];
          const pinyin = [...new Set(pronunciations.filter((item) => item.isZh).map((item) => removeToneMarks(item.pinyin)))].sort();
          if (!pinyin.length) return [];
          const finals = [...new Set(pronunciations.filter((item) => item.isZh).map((item) => removeToneMarks(item.final)))].sort();
          return [{ character, pinyin, finals, families: [...new Set(finals.map(classifyFinal))].sort() }];
        });
      });
    }
    return rhymeIndexPromise;
  };

  const lookupRhyme = async (args: Args): Promise<ChineseRhymeLookup> => {
    const query = bounded(asString(args.query, "query").trim(), 256, "query");
    if (!query) throw new Error("query must not be empty.");
    const matchMode = args.matchMode ?? "family";
    if (matchMode !== "family" && matchMode !== "exact") throw new Error("matchMode must be family or exact.");
    const mode = matchMode as RhymeMatchMode;
    const han = Array.from(query).filter((character) => /[\u3400-\u9fff]/u.test(character));
    const index = await getRhymeIndex();
    let queryPinyin: string[];
    let targetKeys: string[];
    if (han.length) {
      const data = polyphonic(han.join(""), { type: "all", toneType: "none" }) as Array<Array<{ pinyin: string; final: string; isZh: boolean }>>;
      const lastReadings = data.at(-1) ?? [];
      queryPinyin = [...new Set(lastReadings.filter((item) => item.isZh).map((item) => removeToneMarks(item.pinyin)))].sort();
      targetKeys = [...new Set(lastReadings.filter((item) => item.isZh).map((item) => mode === "exact" ? removeToneMarks(item.final) : classifyFinal(item.final)))].sort();
    } else {
      const roman = removeToneMarks(query).replace(/[^a-zv]/gu, "");
      if (!roman) throw new Error("query must contain Chinese characters or pinyin.");
      queryPinyin = [roman];
      const matchedPronunciations = index.flatMap((item) => item.pinyin.filter((pronunciation) => pronunciation === roman).map(() => item));
      const matched = matchedPronunciations[0];
      if (matched) targetKeys = (mode === "exact" ? matched.finals : matched.families);
      else {
        const normalizedFinal = roman.replace(/^(zh|ch|sh|b|p|m|f|d|t|n|l|g|k|h|j|q|x|r|z|c|s|y|w)/u, "");
        targetKeys = [mode === "exact" ? normalizedFinal : classifyFinal(normalizedFinal)].filter(Boolean);
      }
    }
    const characters = index.filter((item) => (mode === "exact" ? item.finals : item.families).some((key) => targetKeys.includes(key)));
    return {
      language: "zh-CN",
      query,
      queryPinyin,
      matchMode: mode,
      rhymeKeys: targetKeys,
      total: characters.length,
      characters: characters.map(({ character, pinyin }) => ({ character, pinyin })),
      coverageNote: "结果覆盖 U+3400–U+9FFF 字符范围内由 pinyin-pro 收录的读音；多音字按全部收录读音匹配。",
    };
  };

  const exportText = async (args: Args) => {
    const title = bounded(asString(args.title, "title", "lyrics"), 256, "title").trim() || "lyrics";
    const draft = bounded(asString(args.draft, "draft"), 1_000_000, "draft");
    const safeName = title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").replace(/\s+/gu, " ").replace(/^\.+|\.+$/gu, "").trim() || "lyrics";
    const root = await ensureRoot();
    const directory = join(root, "lyrics", "exports");
    await mkdir(directory, { recursive: true });
    await assertNoEscapingSymlink(directory, root, true);
    const canonicalDirectory = await realpath(directory);
    assertInsideRoot(root, canonicalDirectory);
    const path = join(canonicalDirectory, `${safeName}.txt`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(draft, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return { succeeded: true, summary: "歌词文本已导出。", detail: path };
  };

  return {
    async invoke(command, args = {}) {
      if (!(LYRIC_COMMANDS as readonly string[]).includes(command)) throw new Error(`Unsupported lyric command: ${command}`);
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Command arguments must be an object.");
      switch (command) {
        case "create_lyric_project":
          return serializeMutation(async () => {
            const projects = await readProjects();
            const project = makeProject(args);
            await saveProjects([project, ...projects]);
            return clone(project);
          });
        case "save_lyric_project":
          return serializeMutation(async () => {
            const id = asString(args.id, "id");
            const projects = await readProjects();
            const index = projects.findIndex((project) => project.id === id);
            if (index < 0) throw new Error("Lyric project was not found.");
            const project = updateProject(projects[index], args);
            projects[index] = project;
            await saveProjects(projects);
            return clone(project);
          });
        case "load_lyric_project": {
          const id = asString(args.id, "id");
          const project = (await readProjects()).find((item) => item.id === id);
          if (!project) throw new Error("Lyric project was not found.");
          return clone(project);
        }
        case "list_lyric_projects":
          return listProjects(args);
        case "restore_lyric_project_version":
          return serializeMutation(async () => {
            const id = asString(args.id, "id");
            const revision = Number(args.revision);
            if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("revision must be a positive integer.");
            const projects = await readProjects();
            const index = projects.findIndex((project) => project.id === id);
            const existing = projects[index];
            const version = existing?.versions.find((item) => item.revision === revision);
            if (index < 0 || !existing || !version) throw new Error("Lyric project version was not found.");
            const restored = updateProject(existing, {}, version);
            projects[index] = restored;
            await saveProjects(projects);
            return clone(restored);
          });
        case "export_lyric_project_text":
          return exportText(args);
        case "build_lyric_template":
          return buildTemplate(args);
        case "lookup_chinese_rhyme":
          return lookupRhyme(args);
      }
    },
  };
}
