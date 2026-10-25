import assert from "node:assert/strict";
import test from "node:test";
import { compiled } from "../_lib/load.mjs";
import { assertProperty, fc } from "../_lib/props.mjs";

const { relocatePath } = await compiled("services/user-data-migration.js");

const segment = fc.stringMatching(/^[A-Za-z0-9 ._()-]{1,12}$/).filter(value => value.trim() === value && !/^\.+$/.test(value));
const unicodeSegment = fc.oneof(segment, fc.constantFrom("张三", "データ", "ÄÖÜ", "ß"));
const segments = fc.array(unicodeSegment, { minLength: 1, maxLength: 4 });

// `from` lives under /src or C:\src and `to` under /dst or D:\dst, so the destination is never inside the source.
const layout = fc.record({ windows: fc.boolean(), from: segments, to: segments, rest: fc.array(unicodeSegment, { maxLength: 4 }) }).map(({ windows, from, to, rest }) => {
  const sep = windows ? "\\" : "/";
  return {
    windows, sep, platform: windows ? "win32" : "linux",
    from: windows ? ["C:", "src", ...from].join(sep) : ["", "src", ...from].join(sep),
    to: windows ? ["D:", "dst", ...to].join(sep) : ["", "dst", ...to].join(sep),
    rest,
  };
});
const join = (base, parts, sep) => [base, ...parts].join(sep);

test("a path inside from maps inside to with the same relative suffix", () => {
  assertProperty(layout, ({ from, to, rest, sep, platform }) => {
    assert.equal(relocatePath(from, from, to, platform), to);
    assert.equal(relocatePath(join(from, rest, sep), from, to, platform), join(to, rest, sep));
  });
});

test("a sibling that shares the prefix, or any path outside from, is left alone", () => {
  assertProperty(fc.tuple(layout, fc.stringMatching(/^[A-Za-z0-9._-]{1,6}$/)), ([{ from, to, rest, sep, platform }, extra]) => {
    assert.equal(relocatePath(from + extra, from, to, platform), undefined, "sibling sharing the prefix");
    assert.equal(relocatePath(join(from + extra, rest, sep), from, to, platform), undefined);
    assert.equal(relocatePath(join(to, rest, sep), from, to, platform), undefined, "destination is outside the source");
    assert.equal(relocatePath(from.slice(0, -1), from, to, platform), undefined, "a parent of from");
  });
});

test("Windows matches case-insensitively and across / and \\; other platforms are exact", () => {
  assertProperty(layout, ({ from, to, rest, windows, sep, platform }) => {
    // ASCII only: toUpperCase() changes the length of letters such as ß, which no path comparison can match.
    const shouted = from.replace(/[a-z]/g, letter => letter.toUpperCase());
    const moved = relocatePath(join(shouted, rest, sep), from, to, platform);
    if (shouted === from || windows) assert.equal(moved, join(to, rest, sep));
    else assert.equal(moved, undefined);
    if (windows && rest.length) {
      const slashed = join(from.replaceAll("\\", "/"), rest, "/");
      assert.equal(relocatePath(slashed, from, to, platform), join(to, rest, "/"), "the suffix keeps the separators it had");
    }
  });
});

test("applying it twice is stable", () => {
  assertProperty(layout, ({ from, to, rest, sep, platform }) => {
    const once = relocatePath(join(from, rest, sep), from, to, platform);
    assert.notEqual(once, undefined);
    assert.equal(relocatePath(once, from, to, platform), undefined, "already-moved paths are not moved again");
  });
});
