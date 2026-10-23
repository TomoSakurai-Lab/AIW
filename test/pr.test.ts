// aiw pr（2026-10-20・docs/design-pr.md §G）。故障注入 260〜269 と、その土台の単体 270〜275。
//
// 偽の Azure DevOps（fetch）と偽の git を注入する。**本物の API は一度も呼ばない**
// （客先に見える draft PR をテストで作らない。初回の実 PR は人間が同席する実タスクで）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { completedTaskWindow } from "../src/engine/observed.js";
import { countTriStatusAny } from "../src/engine/sections.js";
import { deriveFromRemote, type FetchImpl } from "../src/engine/pr/azdo.js";
import {
  buildDescription,
  buildScreensComment,
  DESCRIPTION_LIMIT,
  internalReport,
  isScreensComment,
  isUntouchedByHuman,
  placeScreens,
  scrub
} from "../src/engine/pr/describe.js";
import { runPr, type PrDeps } from "../src/engine/pr/run.js";
import { parseRequested, readPrSource } from "../src/engine/pr/source.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { archivedTaskDirs, makeRoot, runReflection, setStep, validTaskMetadata, writeIn, writeStatus } from "./helpers.js";

// ---- fixtures ---------------------------------------------------------------------------------

const TASK_ID = "TASK-2026-10-20-sample";

const FILES: Record<string, string> = {
  "user-task.md": [
    "# User Task",
    "",
    "## 次タスク：表の見た目をそろえる",
    "",
    "### 1. 実行予算作成画面",
    "",
    "#### 予算編集タブ",
    "",
    "- [ ] 「予算キー」は不要。列表示メニューからも再表示できないようにする。",
    "- [x] 帳票出力のリストを、以下の2種類のみにする。",
    "  1. 実行予算書",
    "  2. 元積内訳書",
    "",
    "### 2. 検証・完了条件",
    "",
    "- 関連テストで検証する。",
    ""
  ].join("\n"),
  "current-task.md": `# Task\n\n- Task ID: ${TASK_ID}\n- Feature ID: FEAT-sample\n`,
  "task-metadata.json": JSON.stringify({
    featureId: "FEAT-sample",
    featureName: "表の見た目をそろえる",
    taskName: "sample",
    summary: "元積の表に共通の罫線を入れた（BL-346）。AC-01 は PASS。フル e2e は未実施。"
  }),
  "context-package.md": "# Task Summary\n\ns\n\n# Files\n\n## Modify\n\n- `src/a.tsx`\n- `src/b.tsx`（`:12`）\n\n## Reference\n\n- `src/c.tsx`\n",
  "current-result.md": [
    "# Summary",
    "",
    "## Acceptance Criteria Verification",
    "| ID | Status | Evidence |",
    "|---|---|---|",
    "| AC-01 | PASS | log |",
    "| AC-02 | FAIL | log |",
    "| AC-03 | NOT VERIFIED | なし |",
    "",
    "## Manual Verification Required",
    "- 画面で罫線の色を目視する。理由は自動化できないため。",
    "",
    "## Files Changed",
    "- `src/a.tsx`: 変更",
    ""
  ].join("\n"),
  "current-review.md": [
    "# Summary",
    "s",
    "## Critical",
    "なし。",
    "## Major",
    "### M1. 罫線が一部で消える",
    "本文",
    "## Minor",
    "## Backlog",
    "### BL-900",
    "- Source: x",
    "- Summary: R5 の記録に穴がある。詳細は後述。",
    "- Status: open",
    "## Ready",
    ""
  ].join("\n")
};

function seedArchive(root: string, opts: { stamp?: string; omit?: string[]; override?: Record<string, string> } = {}): string {
  const dir = path.join(root, "archive", "20261020T000000-FEAT-sample", `${opts.stamp ?? "20261020T054338"}-task`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries({ ...FILES, ...(opts.override ?? {}) })) {
    if (opts.omit?.includes(name)) continue;
    writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

function seedScreenshot(root: string, name = "after-top.png", taskId = TASK_ID): string {
  const dir = path.join(root, "runs", taskId, "screenshots");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  return file;
}

function withPr(config: WorkflowConfig): WorkflowConfig {
  config.settings.pr = { organizationUrl: "https://dev.azure.com/org", project: "proj x", repository: "repo" };
  return config;
}

type FakePr = { pullRequestId: number; isDraft: boolean; status: string; title: string; description: string; sourceRefName: string; targetRefName: string };
type Call = { method: string; path: string; body: any; headers: Record<string, string> };

function fakeAzdo(opts: {
  prs?: FakePr[];
  remoteBranches?: string[];
  failAttach?: (message: string) => Response | null;
  intercept?: (method: string, p: string) => Response | null;
  /** 最初から置いておくスレッド（PR ID → API の形のスレッド）。指摘の取り込みのテスト用 */
  seedThreads?: Record<number, any[]>;
} = {}) {
  const calls: Call[] = [];
  const prs: FakePr[] = [...(opts.prs ?? [])];
  const attachments = new Map<number, Array<{ displayName: string; url: string }>>();
  const threads = new Map<number, Array<{ id: number; comments: Array<{ id: number; parentCommentId: number; content: string }> }>>(
    Object.entries(opts.seedThreads ?? {}).map(([k, v]) => [Number(k), v])
  );
  let nextId = 500;
  const json = (status: number, v: unknown): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json; charset=utf-8" } });
  const fetch: FetchImpl = async (url, init) => {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const p = decodeURIComponent(u.pathname);
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : raw;
    calls.push({ method, path: p, body, headers: { ...(init?.headers as Record<string, string>) } });
    const forced = opts.intercept?.(method, p);
    if (forced) return forced;
    let m: RegExpMatchArray | null;
    if (method === "GET" && /\/_apis\/git\/repositories\/[^/]+$/.test(p)) {
      return json(200, { id: "r1", name: "repo", defaultBranch: "refs/heads/master", webUrl: "https://dev.azure.com/org/proj/_git/repo" });
    }
    if (method === "GET" && p.endsWith("/refs")) {
      const want = String(u.searchParams.get("filter") ?? "").replace(/^heads\//, "");
      const have = (opts.remoteBranches ?? ["feature/sample"]).filter((b) => b === want);
      return json(200, { value: have.map((b) => ({ name: `refs/heads/${b}` })), count: have.length });
    }
    if (method === "GET" && p.endsWith("/pullrequests")) {
      const s = u.searchParams.get("searchCriteria.sourceRefName");
      const t = u.searchParams.get("searchCriteria.targetRefName");
      const v = prs.filter((x) => x.status === "active" && (!s || x.sourceRefName === s) && (!t || x.targetRefName === t));
      return json(200, { value: v.map((x) => ({ ...x, description: x.description.slice(0, 400) })), count: v.length });
    }
    if (method === "GET" && (m = p.match(/\/pullrequests\/(\d+)$/))) {
      const pr = prs.find((x) => x.pullRequestId === Number(m![1]));
      return pr ? json(200, pr) : json(404, { message: "no pr" });
    }
    if (method === "POST" && p.endsWith("/pullrequests")) {
      const pr: FakePr = { pullRequestId: nextId++, isDraft: body.isDraft === true, status: "active", title: body.title, description: body.description, sourceRefName: body.sourceRefName, targetRefName: body.targetRefName };
      prs.push(pr);
      return json(201, pr);
    }
    if (method === "PATCH" && (m = p.match(/\/pullrequests\/(\d+)$/))) {
      const pr = prs.find((x) => x.pullRequestId === Number(m![1]))!;
      if (typeof body.description === "string") pr.description = body.description;
      return json(200, pr);
    }
    if (method === "GET" && (m = p.match(/\/pullRequests\/(\d+)\/threads$/))) {
      return json(200, { value: threads.get(Number(m[1])) ?? [], count: (threads.get(Number(m[1])) ?? []).length });
    }
    if (method === "POST" && (m = p.match(/\/pullRequests\/(\d+)\/threads$/))) {
      const list = threads.get(Number(m[1])) ?? [];
      const t = { id: 900 + list.length, comments: [{ id: 1, parentCommentId: 0, content: body.comments[0].content }] };
      threads.set(Number(m[1]), [...list, t]);
      return json(200, t);
    }
    if (method === "PATCH" && (m = p.match(/\/pullRequests\/(\d+)\/threads\/(\d+)\/comments\/(\d+)$/))) {
      const t = (threads.get(Number(m[1])) ?? []).find((x) => x.id === Number(m[2]))!;
      t.comments.find((c) => c.id === Number(m![3]))!.content = body.content;
      return json(200, t.comments[0]);
    }
    if (method === "GET" && (m = p.match(/\/pullRequests\/(\d+)\/attachments$/))) {
      return json(200, { value: attachments.get(Number(m[1])) ?? [], count: 0 });
    }
    if (method === "POST" && (m = p.match(/\/pullRequests\/(\d+)\/attachments\/(.+)$/))) {
      const failed = opts.failAttach?.(m[2]);
      if (failed) return failed;
      const a = { displayName: m[2], url: `https://dev.azure.com/org/_apis/attachments/${m[2]}` };
      attachments.set(Number(m[1]), [...(attachments.get(Number(m[1])) ?? []), a]);
      return json(201, a);
    }
    return json(404, { message: `no route ${method} ${p}` });
  };
  return { fetch, calls, prs, attachments, threads };
}

/** 偽の git が返すブランチの差分。null なら差分の取得が失敗する */
const BRANCH_FILES = ["src/a.tsx", "src/x.cs"];

type GitOpts = { changed?: string[] | null; ignored?: string[]; tracking?: boolean };

function deps(
  fetch: FetchImpl,
  env: NodeJS.ProcessEnv = { AZURE_DEVOPS_PAT: "test-pat-value" },
  branch = "feature/sample",
  git: GitOpts = {}
) {
  const out: string[] = [];
  const err: string[] = [];
  const changed = git.changed === undefined ? BRANCH_FILES : git.changed;
  const gitCalls: string[][] = [];
  const d: PrDeps = {
    fetch,
    env,
    git: (_repoRoot, args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return `${branch}\n`;
      if (args[0] === "rev-parse" && args[1] === "--verify") {
        if (git.tracking === false) throw new Error("no such ref");
        return "abc\n";
      }
      if (args[0] === "rev-list") return "0\n";
      if (args[0] === "symbolic-ref") return "origin/master\n";
      if (args[0] === "merge-base") {
        if (changed === null) throw new Error("fatal: Not a valid object name origin/master");
        return "base\n";
      }
      if (args[0] === "diff") return `${(changed ?? []).join("\n")}\n`;
      if (args[0] === "check-ignore") {
        if ((git.ignored ?? []).includes(args[2])) return "";
        throw new Error("not ignored");
      }
      if (args[0] === "remote") return "https://primalinc@dev.azure.com/primalinc/BizForecast%20for%20%E6%9D%B1%E6%80%A5%E5%BB%BA%E8%A8%AD/_git/Template.toukyu\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l)
  };
  return { d, out, err, gitCalls, all: (): string => [...out, ...err].join("\n") };
}

const eventLog = (root: string): string => {
  const f = path.join(root, "runs", "execution-log.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8") : "";
};
const writes = (calls: Call[]): Call[] => calls.filter((c) => c.method !== "GET");
const stateBytes = (root: string): string => readFileSync(path.join(root, "state.json"), "utf8");

// ---- 故障注入 -----------------------------------------------------------------------------------

test("260: without AZURE_DEVOPS_PAT, aiw pr explains how to issue and set it, with no stack trace and no API call", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  const azdo = fakeAzdo();
  for (const check of [false, true]) {
    const h = deps(azdo.fetch, {});
    const r = await runPr({ root, config: withPr(config), check }, h.d);
    assert.equal(r.exitCode, 1);
    assert.match(h.all(), /AZURE_DEVOPS_PAT/);
    assert.match(h.all(), /Code: Read & Write/);
    assert.doesNotMatch(h.all(), /\n\s+at /, "no stack trace");
  }
  assert.equal(azdo.calls.length, 0);
});

test("261: the PAT and its base64 forms never reach stdout, stderr, or the Event Log, even when the server echoes them", async () => {
  const pat = `pat-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const b64 = Buffer.from(`:${pat}`).toString("base64");
  const b64raw = Buffer.from(pat).toString("base64");
  const echo = (status: number) => (_m: string, _p: string): Response =>
    new Response(JSON.stringify({ message: `bad token ${pat} / Basic ${b64} / ${b64raw}` }), { status, headers: { "content-type": "application/json" } });
  const { root, config } = makeRoot();
  seedArchive(root);
  seedScreenshot(root);
  const outputs: string[] = [];

  // (a) 読み取りが 500 で PAT を echo（本実行）
  let h = deps(fakeAzdo({ intercept: echo(500) }).fetch, { AZURE_DEVOPS_PAT: pat });
  assert.equal((await runPr({ root, config: withPr(config) }, h.d)).exitCode, 1);
  outputs.push(h.all());
  // (b) --check が 401 で echo
  h = deps(fakeAzdo({ intercept: echo(401) }).fetch, { AZURE_DEVOPS_PAT: pat });
  assert.equal((await runPr({ root, config: withPr(config), check: true }, h.d)).exitCode, 1);
  outputs.push(h.all());
  // (c) 作成は通り、添付の失敗の message が echo
  const azdo = fakeAzdo({ failAttach: () => echo(500)("", "") });
  h = deps(azdo.fetch, { AZURE_DEVOPS_PAT: pat });
  assert.equal((await runPr({ root, config: withPr(config) }, h.d)).exitCode, 0);
  outputs.push(h.all());
  // 送った Authorization は正しい形（伏せていたのは出力だけ）
  assert.equal(azdo.calls[0].headers.Authorization, `Basic ${b64}`);

  const haystack = [...outputs, eventLog(root), ...azdo.prs.map((p) => p.description)].join("\n");
  assert.match(eventLog(root), /"pr\.failed"|"pr\.checked"/, "the failures were recorded");
  for (const secret of [pat, b64, b64raw]) {
    assert.equal(haystack.includes(secret), false, `leaked: ${secret === pat ? "PAT" : "base64 form"}`);
  }
});

test("262: an existing draft PR written by aiw is updated in place — no second PR, no title change", async () => {
  const { root, config } = makeRoot();
  const dir = seedArchive(root);
  // 前のフェーズで aiw が書いた説明文（人の手は入っていない）
  const older = buildDescription({ ...readPrSource(root, dir), requested: [{ heading: "前のフェーズ", items: [{ text: "前の依頼", sub: [] }] }] }, []);
  const azdo = fakeAzdo({
    prs: [{ pullRequestId: 7, isDraft: true, status: "active", title: "人が直したタイトル", description: older.description, sourceRefName: "refs/heads/feature/sample", targetRefName: "refs/heads/master" }]
  });
  const before = stateBytes(root);
  const h = deps(azdo.fetch);
  const r = await runPr({ root, config: withPr(config) }, h.d);
  assert.equal(r.kind, "updated", h.all());
  assert.equal(azdo.calls.filter((c) => c.method === "POST" && c.path.endsWith("/pullrequests")).length, 0, "no new PR");
  const patches = azdo.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
  assert.deepEqual(Object.keys(patches[0].body), ["description"], "title / isDraft are not sent");
  assert.equal(azdo.prs[0].title, "人が直したタイトル");
  assert.ok(isUntouchedByHuman(azdo.prs[0].description), "the new description carries a valid generation key");
  assert.equal(stateBytes(root), before, "state.json is not touched (268)");

  // 2 回目は変更なし（冪等）
  const again = await runPr({ root, config: withPr(config) }, deps(azdo.fetch).d);
  assert.equal(again.kind, "unchanged");
  assert.equal(azdo.calls.filter((c) => c.method === "PATCH").length, 1);
});

test("262b: a published PR, a human-edited description, or two candidates are left alone", async () => {
  const { root, config } = makeRoot();
  const dir = seedArchive(root);
  const mine = buildDescription(readPrSource(root, dir), []).description;
  const base = { status: "active", title: "t", sourceRefName: "refs/heads/feature/sample", targetRefName: "refs/heads/master" };
  const cases: Array<[string, FakePr[]]> = [
    ["published", [{ ...base, pullRequestId: 1, isDraft: false, description: mine }]],
    ["human-edited", [{ ...base, pullRequestId: 2, isDraft: true, description: mine.replace("## 対応した内容\n", "## 対応した内容\n人が足した一文。\n") }]],
    ["no key", [{ ...base, pullRequestId: 3, isDraft: true, description: "手で書いた説明文" }]],
    ["multiple", [{ ...base, pullRequestId: 4, isDraft: true, description: mine }, { ...base, pullRequestId: 5, isDraft: true, description: mine }]]
  ];
  for (const [name, prs] of cases) {
    const azdo = fakeAzdo({ prs });
    const before = stateBytes(root);
    const r = await runPr({ root, config: withPr(config) }, deps(azdo.fetch).d);
    assert.equal(r.kind, "skipped", name);
    assert.equal(r.exitCode, 1, name);
    assert.deepEqual(writes(azdo.calls), [], `${name}: nothing written`);
    assert.equal(stateBytes(root), before, `${name}: state.json untouched`);
  }
  assert.match(eventLog(root), /"reason":"published"/);
  assert.match(eventLog(root), /"reason":"human-edited"/);
});

test("263: when the attachment API fails, the draft PR is still created and the description names where the image is", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  seedScreenshot(root, "before-top.png");
  seedScreenshot(root, "after-top.png");
  const azdo = fakeAzdo({ failAttach: () => new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } }) });
  const before = stateBytes(root);
  const h = deps(azdo.fetch);
  const r = await runPr({ root, config: withPr(config) }, h.d);
  assert.equal(r.kind, "created", h.all());
  assert.equal(r.exitCode, 0);
  const created = azdo.calls.filter((c) => c.method === "POST" && c.path.endsWith("/pullrequests"));
  assert.equal(created.length, 1);
  assert.equal(created[0].body.isDraft, true, "always draft");
  assert.match(
    azdo.threads.get(500)![0].comments[0].content,
    /#### top\n\n\*\*変更前\*\*\n\n保存先: `\.ai-workflow\/runs\/TASK-2026-10-20-sample\/screenshots\/before-top\.png`\n\n\*\*変更後\*\*\n\n保存先: `\.ai-workflow\/runs\/TASK-2026-10-20-sample\/screenshots\/after-top\.png`/
  );
  assert.match(eventLog(root), /"pr\.attachment-failed"/);
  assert.match(h.all(), /公開前に確認/);
  assert.equal(stateBytes(root), before);

  // 添付が成功する場合: 作成 → 添付 → コメントに変更前 → 変更後（説明文には画像を載せず、コメントを指す 1 行だけ）
  const { root: root2, config: config2 } = makeRoot();
  seedArchive(root2);
  seedScreenshot(root2, "before-top.png");
  seedScreenshot(root2, "after-top.png");
  const ok = fakeAzdo();
  assert.equal((await runPr({ root: root2, config: withPr(config2) }, deps(ok.fetch).d)).kind, "created");
  assert.doesNotMatch(ok.prs[0].description, /!\[|attachments/, "no image in the description");
  assert.match(ok.prs[0].description, /変更前 → 変更後の画面は、この PR のコメント「画面（変更前 → 変更後）」に載せています。/);
  assert.match(
    ok.threads.get(500)![0].comments[0].content,
    /^## 画面（変更前 → 変更後）\n\n### その他の画面\n\n#### top\n\n\*\*変更前\*\*\n\n!\[変更前 top\]\(https:\/\/dev\.azure\.com\/org\/_apis\/attachments\/before-top\.[0-9a-f]{8}\.png\)\n\n\*\*変更後\*\*\n\n!\[変更後 top\]\(https:\/\/dev\.azure\.com\/org\/_apis\/attachments\/after-top\.[0-9a-f]{8}\.png\)/
  );
});

test("264: --dry-run calls no API and writes nothing to the Event Log", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  seedScreenshot(root);
  const azdo = fakeAzdo();
  const logBefore = eventLog(root);
  const stBefore = stateBytes(root);
  for (const env of [{ AZURE_DEVOPS_PAT: "x" }, {}]) {
    const h = deps(azdo.fetch, env);
    const r = await runPr({ root, config: withPr(config), dryRun: true }, h.d);
    assert.equal(r.kind, "dry-run");
    assert.equal(r.exitCode, 0);
    assert.match(h.all(), /----- 説明文 -----/);
    assert.match(h.all(), /after-top\.[0-9a-f]{8}\.png/, "the planned attachment is listed");
    assert.match(h.all(), /対になっていない画面: top（変更前なし）/);
  }
  assert.equal(azdo.calls.length, 0, "fetch was never called");
  assert.equal(eventLog(root), logBefore);
  assert.equal(stateBytes(root), stBefore);
});

test("265: missing artifacts are written as 'no record', never as zero or as verified", async () => {
  const { root, config } = makeRoot();
  seedArchive(root, { omit: ["user-task.md", "current-review.md", "context-package.md", "current-result.md", "task-metadata.json"] });
  const h = deps(fakeAzdo().fetch, undefined, undefined, { changed: null });
  await runPr({ root, config, dryRun: true }, h.d);
  const text = h.all();
  const description = text.split("----- 説明文 -----")[1];
  assert.match(description, /## 対応した内容\n依頼の記録なし/);
  for (const phrase of ["概要（task-metadata）: 記録なし", "変更ファイル（ブランチの差分）: 取れない", "突き合わせ: 検査の記録なし", "受け入れ条件: 記録なし", "手動確認: 記録なし", "レビュー: 記録なし"]) {
    assert.ok(text.includes(phrase), `missing: ${phrase}\n${text}`);
  }
  assert.doesNotMatch(text, /PASS \d/);
  assert.doesNotMatch(text, /Critical 0/);

  // review がテンプレートのまま
  const { root: r2, config: c2 } = makeRoot();
  const dir2 = seedArchive(r2);
  copyFileSync(path.join(r2, "templates", "current-review.md"), path.join(dir2, "current-review.md"));
  const h2 = deps(fakeAzdo().fetch);
  await runPr({ root: r2, config: c2, dryRun: true }, h2.d);
  assert.match(h2.all(), /レビュー: 記録なし（テンプレートのまま）/);

  // 依頼文にチェックボックスが無い → 作業記録の要約で代え、見出しと stdout で区別する
  const { root: r3, config: c3 } = makeRoot();
  seedArchive(r3, { omit: ["context-package.md", "current-result.md"], override: { "user-task.md": "# User Task\n\n地の文だけの依頼。\n" } });
  const h3 = deps(fakeAzdo().fetch);
  await runPr({ root: r3, config: c3, dryRun: true }, h3.d);
  assert.match(h3.all(), /## 対応した内容（作業記録の要約）\n元積の表に共通の罫線を入れた。/);
  assert.match(h3.all(), /チェックボックスの項目が無いため/);
  assert.match(h3.all(), /突き合わせ: このタスクの変更宣言の記録が無いため省きました/);
});

test("266: an oversized record is trimmed in stages with an explicit note; if it still does not fit, no PR is made", async () => {
  const { root, config } = makeRoot();
  const items = Array.from({ length: 60 }, (_, i) => `- [ ] 項目 ${i} ${"あ".repeat(150)}。続きの注文。\n  1. 子の項目`).join("\n");
  const dir = seedArchive(root, { override: { "user-task.md": `# U\n\n### 画面\n\n${items}\n` } });
  const d = buildDescription(readPrSource(root, dir), []);
  assert.equal(d.overLimit, false);
  assert.ok(d.chars <= DESCRIPTION_LIMIT, `${d.chars}`);
  assert.deepEqual(d.truncations, ["対応した内容"]);
  assert.match(d.description, /以下省略。全文はタスクの記録を参照/);
  assert.match(d.description, /ほか \d+ 件/);
  assert.ok(isUntouchedByHuman(d.description), "trimmed text still carries its key");

  // 見出しが極端に長く、全段を締めても収まらない → 作らない
  const groups = Array.from({ length: 30 }, (_, i) => `### ${"見".repeat(300)}${i}\n\n- [ ] 項目`).join("\n\n");
  seedArchive(root, { stamp: "20261021T000000", override: { "user-task.md": `# U\n\n${groups}\n` } });
  const azdo = fakeAzdo();
  const r = await runPr({ root, config: withPr(config) }, deps(azdo.fetch).d);
  assert.equal(r.exitCode, 1);
  assert.deepEqual(writes(azdo.calls), [], "no PR when the description cannot fit");
});

test("267: the pr module does not import state / engine / completion, and only azdo.ts reveals the PAT", () => {
  const prDir = path.join(process.cwd(), "src", "engine", "pr");
  for (const f of readdirSync(prDir).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(path.join(prDir, f), "utf8");
    assert.doesNotMatch(text, /from\s+["']\.\.\/(?:state|engine|completion)\.js["']/, `${f} must not reach the task state`);
  }
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name.endsWith(".ts")) {
        // 呼び出しだけを数える（コメントでの言及は数えない）
        const code = readFileSync(abs, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        const n = (code.match(/\.reveal\(\)/g) ?? []).length;
        if (n > 0) offenders.push(`${path.relative(process.cwd(), abs).replace(/\\/g, "/")}:${n}`);
      }
    }
  };
  walk(path.join(process.cwd(), "src"));
  assert.deepEqual(offenders, ["src/engine/pr/azdo.ts:1"]);
});

test("269: on the target branch, or with the branch not pushed, nothing is written and the fix is explained", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  for (const [branch, remote, pattern] of [
    ["master", ["master"], /対象ブランチと同じ/],
    ["feature/sample", [], /git push -u origin feature\/sample/],
    ["HEAD", [], /detached HEAD/]
  ] as Array<[string, string[], RegExp]>) {
    const azdo = fakeAzdo({ remoteBranches: remote });
    const h = deps(azdo.fetch, undefined, branch);
    const r = await runPr({ root, config: withPr(config) }, h.d);
    assert.equal(r.exitCode, 1, branch);
    assert.match(h.all(), pattern);
    assert.deepEqual(writes(azdo.calls), [], `${branch}: no write`);
  }
});

// ---- 土台 -------------------------------------------------------------------------------------

test("270: settings are derived from the git remote forms, dropping the user name", () => {
  assert.deepEqual(
    deriveFromRemote("https://primalinc@dev.azure.com/primalinc/BizForecast%20for%20%E6%9D%B1%E6%80%A5%E5%BB%BA%E8%A8%AD/_git/Template.toukyu"),
    { organizationUrl: "https://dev.azure.com/primalinc", project: "BizForecast for 東急建設", repository: "Template.toukyu" }
  );
  assert.deepEqual(deriveFromRemote("git@ssh.dev.azure.com:v3/org/proj/repo"), { organizationUrl: "https://dev.azure.com/org", project: "proj", repository: "repo" });
  assert.deepEqual(deriveFromRemote("https://org.visualstudio.com/DefaultCollection/proj/_git/repo"), { organizationUrl: "https://org.visualstudio.com", project: "proj", repository: "repo" });
  assert.deepEqual(deriveFromRemote("https://tfs.example.local/tfs/Coll/proj/_git/repo"), { organizationUrl: "https://tfs.example.local/tfs/Coll", project: "proj", repository: "repo" });
  assert.equal(deriveFromRemote("https://github.com/o/r.git"), null);
});

test("271: the tri-state tally reads tables as well as Status: lines; the summary's own tally is unchanged", () => {
  const md = "## Acceptance Criteria Verification\n| ID | **Status** | E |\n|---|---|---|\n| AC-01 | PASS | x |\n| AC-02 | `NOT VERIFIED` | x |\n| AC-03 | maybe | x |\n\n- Status: FAIL\n";
  assert.deepEqual(countTriStatusAny(md, "## Acceptance Criteria Verification"), { pass: 1, fail: 1, notVerified: 1, unrecognized: 1 });
  assert.equal(countTriStatusAny("# Other\n", "## Acceptance Criteria Verification"), null, "absent stays null");
});

test("272: a completed task's window ends at the reflection transition after its archive stamp", () => {
  const t = (iso: string, rec: Record<string, unknown>) => ({ timestamp: iso, ...rec });
  const log = [
    t("2026-10-19T00:00:00Z", { event: "transition", from: "reflection", to: "task-planning" }),
    t("2026-10-19T01:00:00Z", { event: "step.completed", step: "fix" }),
    t("2026-10-19T02:00:00Z", { event: "transition", from: "reflection", to: "complete" }),
    t("2026-10-19T03:00:00Z", { event: "step.completed", step: "fix" }),
    t("2026-10-19T03:30:00Z", { event: "step.completed", step: "fix" }),
    t("2026-10-19T04:00:00Z", { event: "transition", from: "reflection", to: "complete" }),
    t("2026-10-19T05:00:00Z", { event: "pr.created" })
  ];
  const w = completedTaskWindow(log, new Date("2026-10-19T03:59:58Z"))!;
  assert.equal(w.filter((r) => r.event === "step.completed").length, 2);
  assert.equal(completedTaskWindow(log, new Date("2026-10-19T04:00:01Z")), null, "no boundary after the stamp → unknown, not empty");
});

test("273: internal IDs are removed and fixed terms translated, without rewording the rest", () => {
  assert.equal(scrub("撤去した（BL-346）。AC-01 は PASS。"), "撤去した。確認済み。");
  assert.equal(scrub("R5 の「記録」に穴がある"), "「記録」に穴がある");
  assert.equal(scrub("（BL-351 / BL-363 解消）"), "（解消）");
  assert.equal(scrub("フル e2e が未実施"), "画面の自動テスト一式が未実施");
  assert.equal(scrub("TASK-2026-10-19-grid-common-baseline の記録と FEAT-grid-common"), "の記録と");
});

test("274: archiveArtifacts keeps the task's context-package.md, and the next research cannot overwrite the record", () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "task-metadata.json", validTaskMetadata);
  writeIn(root, "context-package.md", "# Files\n\n## Modify\n\n- `src/first.tsx`\n");
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });
  assert.equal(runReflection(root, config).kind, "transitioned");
  const [dir] = archivedTaskDirs(root);
  const archived = path.join(root, "archive", "single", dir, "context-package.md");
  assert.ok(existsSync(archived), "context-package.md is archived");
  writeIn(root, "context-package.md", "# Files\n\n## Modify\n\n- `src/second.tsx`\n"); // 次の research
  assert.match(readFileSync(archived, "utf8"), /src\/first\.tsx/);
});

test("275: end to end — a real reflection's archive and Event Log feed the dry-run (window found from the archive stamp)", async () => {
  const { root, config } = makeRoot();
  setStep(root, "reflection");
  writeIn(root, "task-metadata.json", validTaskMetadata);
  writeIn(root, "context-package.md", "# Files\n\n## Modify\n\n- `src/first.tsx`\n");
  writeIn(root, "current-task.md", `# Task\n\n- Task ID: ${TASK_ID}\n`);
  writeIn(root, "user-task.md", "# U\n\n### 一覧画面\n\n- [ ] 列を削除する。\n");
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });
  assert.equal(runReflection(root, config).kind, "transitioned");
  // 単一タスク（archive/single）は Task ID でブランチと照合する（TASK-2026-10-20-sample ↔ task/2026-10-20-sample）
  const h = deps(fakeAzdo().fetch, undefined, "task/2026-10-20-sample", { changed: ["src/first.tsx", "src/other.cs"] });
  const r = await runPr({ root, config, dryRun: true }, h.d);
  assert.equal(r.kind, "dry-run");
  assert.match(h.all(), new RegExp(`（${TASK_ID}）`));
  assert.match(h.all(), /## 対応した内容\n\n### 一覧画面\n- 列を削除する。/, "user-task.md is archived and read");
  assert.match(h.all(), /変更ファイル（ブランチの差分）: 2 件/);
  assert.doesNotMatch(h.all(), /変更宣言にあってブランチの差分に無い/, "the archived declaration is all in the branch");
  // implementation / fix が走っていないタスクなので、検査の記録は無いと書く（済みと書かない）
  assert.match(h.all(), /突き合わせ: 検査の記録なし/);
});

// ---- 2026-10-23 改訂（初回の --dry-run から・docs/design-pr.md §A-2b / §A-3 追記 / §A-6）---------------

test("276: the branch diff is compared with the declaration on stdout; neither file list goes into the description", async () => {
  const { root, config } = makeRoot();
  seedArchive(root, {
    override: { "context-package.md": "# Files\n\n## Modify\n\n- `src/a.tsx`\n- `tests/e2e/ignored.spec.ts`\n- `src/uncommitted.tsx`\n" }
  });
  const h = deps(fakeAzdo().fetch, undefined, undefined, { changed: ["src/a.tsx", "src/x.cs"], ignored: ["tests/e2e/ignored.spec.ts"] });
  await runPr({ root, config, dryRun: true }, h.d);
  const [head, description] = h.all().split("----- 説明文 -----");
  assert.doesNotMatch(description, /src\/|ignored\.spec|変更したファイル/, "no file list in the customer text");
  assert.match(head, /変更ファイル（ブランチの差分）: 2 件/);
  assert.match(head, /変更宣言にあってブランチの差分に無いファイル（2 件・説明文には出していません）/);
  assert.match(head, /tests\/e2e\/ignored\.spec\.ts（ignore 対象）/);
  assert.match(head, /src\/uncommitted\.tsx（差分に無い/);
  // 差分は push 済みの追跡ブランチ（origin/<ブランチ>）を origin/<対象> の merge-base から
  assert.ok(h.gitCalls.some((a) => a.join(" ") === "merge-base origin/master origin/feature/sample"), JSON.stringify(h.gitCalls));

  // 追跡ブランチが無ければ HEAD と比べ、そう言う
  const h2 = deps(fakeAzdo().fetch, undefined, undefined, { tracking: false });
  await runPr({ root, config, dryRun: true }, h2.d);
  assert.match(h2.all(), /origin\/feature\/sample が無いため、ローカルの HEAD と比べました/);
  assert.ok(h2.gitCalls.some((a) => a.join(" ") === "merge-base origin/master HEAD"));

  // 本実行でも突き合わせは stderr に出る
  const azdo = fakeAzdo();
  const h3 = deps(azdo.fetch, undefined, undefined, { changed: ["src/a.tsx"], ignored: ["tests/e2e/ignored.spec.ts"] });
  assert.equal((await runPr({ root, config: withPr(config) }, h3.d)).kind, "created");
  assert.doesNotMatch(azdo.prs[0].description, /src\//);
  assert.match(h3.err.join("\n"), /ignore 対象/);
});

test("277: a multi-line Backlog Summary is read through its continuation lines (internal report)", () => {
  const { root } = makeRoot();
  const dir = seedArchive(root, {
    override: {
      "current-review.md": FILES["current-review.md"].replace(
        "- Summary: R5 の記録に穴がある。詳細は後述。",
        "- Summary: 契約が 2 行に与えられており、\n  親行の下に別の子が並ぶ。続きの文。\n- Status: open"
      )
    }
  });
  const src = readPrSource(root, dir);
  assert.ok(src.review.state === "present");
  assert.deepEqual(src.review.backlog, ["契約が 2 行に与えられており、 親行の下に別の子が並ぶ。続きの文。"]);
  assert.ok(internalReport(src, null).some((l) => l.includes("親行の下に別の子が並ぶ")));
});

test("278: 'ID ×N' becomes a known-issue count, and file names containing e2e are left as they are", () => {
  assert.equal(scrub("失敗 3 件は BL-344 ×2 と `BL-236` ×1 に帰属"), "失敗 3 件は既知の課題（2 件）と既知の課題（1 件）に帰属");
  assert.equal(scrub("実測 `e2e-hierarchy-final.log:16` と tests/e2e/a.spec.ts"), "実測 `e2e-hierarchy-final.log:16` と tests/e2e/a.spec.ts");
  assert.equal(scrub("e2e を 1 回"), "画面の自動テストを 1 回");
});

test("279: real-data-looking words are listed for the human, not removed from the description", async () => {
  const { root, config } = makeRoot();
  seedArchive(root, {
    override: {
      "user-task.md": "# U\n\n### 取極タブ\n\n- [ ] 契約 `19080010` の `K0221100 城南設備` と `B0900002 東都電工` を親子で表示する。\n- [ ] CSV を「実行予算_建設クラウドWeb版連携用CSV」にする。\n"
    }
  });
  const h = deps(fakeAzdo().fetch);
  await runPr({ root, config, dryRun: true }, h.d);
  const [head, body] = h.all().split("----- 説明文 -----");
  assert.match(head, /実データらしい語があります/);
  const listed = head.split("実データらしい語があります")[1].split("\n")[1];
  for (const w of ["19080010", "K0221100", "B0900002", "城南設備", "東都電工"]) assert.ok(listed.includes(w), w);
  assert.doesNotMatch(listed, /実行予算_建設|2026/, "a product name ending in 建設+katakana and dates are not flagged");
  assert.ok(body.includes("19080010"), "not removed: rewording is the human's call");
});

test("280: the request checklist is read by screen / tab, with checkbox items only and their numbered children", () => {
  const groups = parseRequested(FILES["user-task.md"]);
  assert.deepEqual(groups, [
    {
      heading: "実行予算作成画面 / 予算編集タブ",
      items: [
        { text: "「予算キー」は不要。列表示メニューからも再表示できないようにする。", sub: [] },
        { text: "帳票出力のリストを、以下の2種類のみにする。", sub: ["1. 実行予算書", "2. 元積内訳書"] }
      ]
    }
  ]);
  // 進め方・完了条件（チェックボックスでない箇条書き）は拾わない
  assert.ok(!JSON.stringify(groups).includes("関連テスト"));
  // 見出しが ### より浅いだけなら、その見出しでまとめる
  assert.deepEqual(parseRequested("## 依頼\n\n- [ ] 一つ目\n"), [{ heading: "依頼", items: [{ text: "一つ目", sub: [] }] }]);
});

test("281: screenshots pair by name across the feature's tasks — the first 'before' and the last 'after'", () => {
  const { root } = makeRoot();
  const first = seedArchive(root, { stamp: "20261020T010000", override: { "current-task.md": "# Task\n\n- Task ID: TASK-a\n" } });
  const second = seedArchive(root, { stamp: "20261020T020000", override: { "current-task.md": "# Task\n\n- Task ID: TASK-b\n" } });
  seedArchive(root, { stamp: "20261020T030000", override: { "current-task.md": "# Task\n\n- Task ID: TASK-c\n" } });
  seedScreenshot(root, "before-grid.png", "TASK-a");
  seedScreenshot(root, "after-grid.png", "TASK-a");
  seedScreenshot(root, "before-grid.png", "TASK-b"); // 2 回目の変更前は使わない（PR 全体の変更前は最初のもの）
  seedScreenshot(root, "after-grid.png", "TASK-b");
  seedScreenshot(root, "after-dialog.png", "TASK-b");
  seedScreenshot(root, "after-later.png", "TASK-c"); // このタスクより後のタスクは含めない
  const rel = (f: string | null): string | null => (f ? path.relative(root, f).replace(/\\/g, "/") : null);
  const shots = readPrSource(root, second).shots.map((s) => ({ name: s.name, before: rel(s.before), after: rel(s.after) }));
  assert.deepEqual(shots, [
    { name: "dialog", before: null, after: "runs/TASK-b/screenshots/after-dialog.png" },
    { name: "grid", before: "runs/TASK-a/screenshots/before-grid.png", after: "runs/TASK-b/screenshots/after-grid.png" }
  ]);
  assert.equal(readPrSource(root, first).shots.length, 1);
  const c = buildScreensComment(readPrSource(root, second), [
    { name: "dialog", before: null, after: { url: "u1", displayPath: "p1" } },
    { name: "grid", before: { url: null, displayPath: "runs/x/before-grid.png" }, after: { url: "u2", displayPath: "p2" } }
  ])!;
  assert.match(c.content, /#### dialog\n\n\*\*変更前\*\*\n\n（なし）\n\n\*\*変更後\*\*\n\n!\[変更後 dialog\]\(u1\)/);
  assert.match(c.content, /#### grid\n\n\*\*変更前\*\*\n\n保存先: `runs\/x\/before-grid\.png`\n\n\*\*変更後\*\*\n\n!\[変更後 grid\]\(u2\)/);
  assert.doesNotMatch(c.content, /\| --- \|/, "no table: images are not squeezed into columns");
  assert.ok(isScreensComment(c.content) && isUntouchedByHuman(c.content), "the comment carries its marker and key");
  assert.equal(buildScreensComment(readPrSource(root, second), []), null, "no screens, no comment");
});

test("282: the description has only the two sections; the internal record stays on stdout", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  const h = deps(fakeAzdo().fetch);
  await runPr({ root, config, dryRun: true }, h.d);
  const [head, body] = h.all().split("----- 説明文 -----");
  const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["対応した内容"], "no 概要 / 確認結果 / レビュー / 変更したファイル (and no 画面 without screenshots)");
  assert.match(body, /### 実行予算作成画面 \/ 予算編集タブ\n- 「予算キー」は不要。列表示メニューからも再表示できないようにする。\n- 帳票出力のリストを、以下の2種類のみにする。\n  1\. 実行予算書\n  2\. 元積内訳書/);
  assert.match(head, /--- 内部の確認結果（説明文には出しません）---/);
  assert.match(head, /受け入れ条件: PASS 1 \/ FAIL 1 \/ NOT VERIFIED 1（全 3）/);
  assert.match(head, /レビュー: Critical 0 \/ Major 1/);
});


test("283: the task record is chosen by the branch, not by recency; with no match nothing is made", async () => {
  const { root, config } = makeRoot();
  const seed = (group: string, stamp: string, featureName: string): string => {
    const dir = path.join(root, "archive", group, `${stamp}-task`);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(FILES)) writeFileSync(path.join(dir, name), content, "utf8");
    writeFileSync(path.join(dir, "task-metadata.json"), JSON.stringify({ featureName, summary: featureName }), "utf8");
    return dir;
  };
  seed("20261022T085248-FEAT-alpha", "20261022T100000", "アルファ 1");
  const alphaLatest = seed("20261022T085248-FEAT-alpha", "20261022T110000", "アルファ 2");
  const beta = seed("20261023T010000-FEAT-beta", "20261023T020000", "ベータ（一番新しい）");
  seed("FEAT-old", "20261001T000000", "日付なしの旧形式");

  const title = (h: { all: () => string }): string | undefined => h.all().match(/^タイトル（作成時のみ）: (.+)$/m)?.[1];
  // 一番新しい archive（beta）ではなく、ブランチ（alpha）の一番新しいタスク
  let h = deps(fakeAzdo().fetch, undefined, "feature/alpha");
  assert.equal((await runPr({ root, config, dryRun: true }, h.d)).kind, "dry-run");
  assert.equal(title(h), "アルファ 2");
  assert.ok(h.all().includes(path.basename(alphaLatest)), "the alpha task directory is the input");
  // 日付なしの旧形式のフォルダも feature ID で引ける
  h = deps(fakeAzdo().fetch, undefined, "feature/old");
  await runPr({ root, config, dryRun: true }, h.d);
  assert.equal(title(h), "日付なしの旧形式");

  // 対応する記録が無い → dry-run でも本実行でも止まり、別の記録を使わない
  h = deps(fakeAzdo().fetch, undefined, "feature/gamma");
  const dry = await runPr({ root, config, dryRun: true }, h.d);
  assert.equal(dry.exitCode, 1);
  assert.match(h.all(), /ブランチ feature\/gamma に対応するタスクの記録が archive にありません（feature ID が「FEAT-gamma」/);
  assert.doesNotMatch(h.all(), /----- 説明文 -----/);
  const azdo = fakeAzdo({ remoteBranches: ["feature/gamma"] });
  const real = await runPr({ root, config: withPr(config) }, deps(azdo.fetch, undefined, "feature/gamma").d);
  assert.equal(real.exitCode, 1);
  assert.deepEqual(azdo.calls, [], "no API call at all when there is no record for the branch");
  assert.match(eventLog(root), /"reason":"no-task-record-for-branch"/);

  // --task が明示されていれば使う。ブランチと合わなければ警告だけ
  h = deps(fakeAzdo().fetch, undefined, "feature/alpha");
  await runPr({ root, config, dryRun: true, taskDir: beta }, h.d);
  assert.equal(title(h), "ベータ（一番新しい）");
  assert.match(h.all(), /--task の記録（beta）は今のブランチ（feature\/alpha）と名前が合いません/);
});

test("284: per-tab screenshots labelled in labels.json sit right under that tab's items; gaps are reported before the PR is made", async () => {
  const { root, config } = makeRoot();
  seedArchive(root, {
    override: {
      "user-task.md": [
        "# U",
        "",
        "### 1. 工種別予算管理表",
        "",
        "#### 取極（実績）タブ",
        "",
        "- [ ] ボタンを常に活性にする。",
        "",
        "#### 取極外タブ",
        "",
        "- [ ] 列を移動する。",
        "",
        "#### 共通",
        "",
        "- [ ] 枠線をグレーにする。",
        "",
        "### 2. 当該予算費消管理表",
        "",
        "#### 共通",
        "",
        "- [ ] 縦幅を固定する。",
        ""
      ].join("\n")
    }
  });
  for (const n of ["jisseki", "jisseki-editing", "torikimegai", "common", "loose", "unknown"]) {
    seedScreenshot(root, `before-${n}.png`);
    seedScreenshot(root, `after-${n}.png`);
  }
  writeFileSync(
    path.join(root, "runs", TASK_ID, "screenshots", "labels.json"),
    JSON.stringify({
      jisseki: "工種別予算管理表 / 取極（実績）タブ", // 完全一致
      "jisseki-editing": "工種別予算管理表 / 取極（実績）タブ", // 同じタブにもう 1 対（状態違い）
      torikimegai: "取極外タブ", // 末尾一致（一意）
      common: "共通", // 末尾一致だが 2 つの見出しに当たる → 置けない
      unknown: "存在しない画面"
    }),
    "utf8"
  );
  const h = deps(fakeAzdo().fetch);
  await runPr({ root, config, dryRun: true }, h.d);
  const [head, rest] = h.all().split("----- 説明文 -----");
  const [description, comment] = rest.split("----- コメント（画面）");
  assert.doesNotMatch(description, /!\[/, "images live in the comment, not in the description");

  // 取極（実績）タブ: 説明文と同じ見出しの下に 2 対（複数なので小見出し。ラベル = 見出しなら「全体」）
  assert.match(
    comment,
    /### 工種別予算管理表 \/ 取極（実績）タブ\n\n#### 全体\n\n\*\*変更前\*\*\n\n!\[変更前 工種別予算管理表 \/ 取極（実績）タブ\]/
  );
  // 取極外タブ: 末尾一致で当たる・1 対なので小見出しなし
  assert.match(comment, /### 工種別予算管理表 \/ 取極外タブ\n\n\*\*変更前\*\*\n\n!\[変更前 取極外タブ\]/);
  // 置けない画像は「その他の画面」へ（ラベルがあればラベルを小見出しに）
  const tail = comment.split("### その他の画面")[1];
  assert.ok(tail, "the leftover section exists");
  for (const s of ["#### 共通", "#### loose", "#### 存在しない画面"]) assert.ok(tail.includes(s), s);
  assert.ok(!tail.includes("取極（実績）タブ"), "placed screens are not repeated");

  // PR を作る前に気づけるように
  assert.match(head, /⚠ 比較のスクショが無い見出し（2 件）: 工種別予算管理表 \/ 共通、当該予算費消管理表 \/ 共通/);
  assert.match(head, /common（ラベル「共通」が見出しに当たらない）/);
  assert.match(head, /loose（labels\.json にラベルが無い）/);
});

test("285: a trailing caption in the label tells shots of the same tab apart, without breaking headings that end in parentheses", () => {
  const headings = ["工種別予算管理表 / 取極（実績）タブ", "工種別予算管理表 / 取極（今後所要）", "当該予算費消管理表 / 共通"];
  const screen = (name: string, label: string) => ({ name, before: null, after: null, label });
  const { byHeading, rest } = placeScreens(headings, [
    screen("a", "工種別予算管理表 / 取極（実績）タブ"),
    screen("a-right", "工種別予算管理表 / 取極（実績）タブ（右側の列）"), // 補足を外して当たる
    screen("b", "取極（今後所要）"), // 見出し自体が（…）で終わる: 補足と誤解しない（末尾一致で当たる）
    screen("c", "当該予算費消管理表 / 共通（工種を複数選んだ状態）"),
    screen("d", "存在しない画面（補足）")
  ]);
  assert.deepEqual(byHeading.get(0)?.map((s) => s.name), ["a", "a-right"]);
  assert.deepEqual(byHeading.get(1)?.map((s) => s.name), ["b"]);
  assert.deepEqual(byHeading.get(2)?.map((s) => s.name), ["c"]);
  assert.deepEqual(rest.map((s) => s.name), ["d"]);
});

test("286: the screens comment is created once, left alone when unchanged or edited by a human, and updated otherwise; a failure keeps the PR", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  seedScreenshot(root, "before-top.png");
  seedScreenshot(root, "after-top.png");
  const azdo = fakeAzdo();
  const run = async () => runPr({ root, config: withPr(config) }, deps(azdo.fetch).d);
  const threadsOf = () => azdo.threads.get(500) ?? [];
  const posts = () => azdo.calls.filter((c) => c.method === "POST" && c.path.endsWith("/threads")).length;
  const patches = () => azdo.calls.filter((c) => c.method === "PATCH" && /\/comments\/\d+$/.test(c.path)).length;

  assert.equal((await run()).kind, "created");
  assert.equal(threadsOf().length, 1);
  assert.equal(posts(), 1);

  // 2 回目: 説明文もコメントも変わらない → 何も書かない（画像も再利用）
  assert.equal((await run()).kind, "unchanged");
  assert.equal(posts(), 1, "no second comment");
  assert.equal(patches(), 0);
  assert.equal(azdo.calls.filter((c) => c.method === "POST" && c.path.includes("/attachments/")).length, 2, "images reused");

  // 変更後の画像を撮り直した → コメントだけ更新
  writeFileSync(path.join(root, "runs", TASK_ID, "screenshots", "after-top.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]));
  await run();
  assert.equal(posts(), 1);
  assert.equal(patches(), 1);
  assert.match(eventLog(root), /"pr\.screens"[^\n]*"action":"updated"/);

  // 人がコメントを直した → 上書きしない
  threadsOf()[0].comments[0].content = threadsOf()[0].comments[0].content.replace("### その他の画面", "### その他の画面\n人が足した一文。");
  seedScreenshot(root, "after-top.png"); // 内容を戻して差分を作る
  const h = deps(azdo.fetch);
  await runPr({ root, config: withPr(config) }, h.d);
  assert.equal(patches(), 1, "a human-edited comment is not overwritten");
  assert.match(h.all(), /画面のコメントは人の手で直されています/);

  // コメントの API が落ちても PR の作成は取り消さない（report）
  const { root: r2, config: c2 } = makeRoot();
  seedArchive(r2);
  seedScreenshot(r2, "before-top.png");
  seedScreenshot(r2, "after-top.png");
  const broken = fakeAzdo({
    intercept: (m, p) => (m === "POST" && p.endsWith("/threads") ? new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } }) : null)
  });
  const h2 = deps(broken.fetch);
  const r = await runPr({ root: r2, config: withPr(c2) }, h2.d);
  assert.equal(r.kind, "created");
  assert.equal(r.exitCode, 0);
  assert.match(h2.all(), /画面のコメントを作れませんでした（PR はそのままです）/);
  assert.match(eventLog(r2), /"stage":"comment"/);
});

test("287: twenty images (ten tabs' pairs) are all attached; only an absurd count is held back, and the dry-run says so", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  for (let i = 0; i < 10; i++) {
    seedScreenshot(root, `before-tab${i}.png`);
    seedScreenshot(root, `after-tab${i}.png`);
  }
  const azdo = fakeAzdo();
  assert.equal((await runPr({ root, config: withPr(config) }, deps(azdo.fetch).d)).kind, "created");
  assert.equal(azdo.calls.filter((c) => c.method === "POST" && c.path.includes("/attachments/")).length, 20, "all 20 attached");
  assert.doesNotMatch(azdo.threads.get(500)![0].comments[0].content, /保存先:/);
  assert.doesNotMatch(eventLog(root), /"pr\.attachment-failed"/);

  // 60 枚を超えた分は添付しない（歯止め）。--dry-run の ⚠ で見える
  for (let i = 10; i < 31; i++) {
    seedScreenshot(root, `before-tab${i}.png`);
    seedScreenshot(root, `after-tab${i}.png`);
  }
  const h = deps(fakeAzdo().fetch);
  await runPr({ root, config: withPr(config), dryRun: true }, h.d);
  assert.match(h.all(), /⚠ 添付しない画像が 2 枚あります（コメントには保存先のパスを書きます）: 60 枚を超えた/);
});

// ---- 指摘への対応（第 n 回）: --reply（2026-10-23・設計 §I）--------------------------------------------

/** 指摘への対応の単一タスク（archive/single）。依頼文に指摘のチェックボックス、スクショはそのタスクの分 */
function seedFeedbackTask(root: string, stamp: string, taskId: string, items: string[], shots: string[] = []): string {
  const dir = path.join(root, "archive", "single", `${stamp}-task`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "current-task.md"), `# Task\n\n- Task ID: ${taskId}\n`, "utf8");
  writeFileSync(path.join(dir, "user-task.md"), `# U\n\n### 1. 実行予算作成画面\n\n#### 予算編集タブ\n\n${items.map((i) => `- [ ] ${i}`).join("\n")}\n`, "utf8");
  for (const s of shots) seedScreenshot(root, s, taskId);
  return dir;
}

test("288: the round's task is the one archived after the branch's last report; none or several stop with the reason", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  // まだ PR を作っていない
  let h = deps(fakeAzdo().fetch);
  assert.equal((await runPr({ root, config, reply: true, dryRun: true }, h.d)).exitCode, 1);
  assert.match(h.all(), /まだ aiw pr で PR を作った記録がありません/);

  // PR を作った（Event Log に pr.created と taskDir）
  const azdo = fakeAzdo();
  assert.equal((await runPr({ root, config: withPr(config) }, deps(azdo.fetch).d)).kind, "created");
  h = deps(azdo.fetch);
  assert.equal((await runPr({ root, config, reply: true, dryRun: true }, h.d)).exitCode, 1);
  assert.match(h.all(), /前回の報告（20261020T054338）より後に終わったタスクの記録がありません/);

  // 指摘への対応のタスクが 1 本 → それを使う（第 1 回）
  seedFeedbackTask(root, "20261021T000000", "TASK-2026-10-21-fb1", ["予算キーの列を消す。"]);
  h = deps(azdo.fetch);
  assert.equal((await runPr({ root, config, reply: true, dryRun: true }, h.d)).kind, "dry-run");
  assert.match(h.all(), /その回のタスク: \.ai-workflow\/archive\/single\/20261021T000000-task（TASK-2026-10-21-fb1）/);
  assert.match(h.all(), /## 指摘への対応（第 1 回）\n\n### 実行予算作成画面 \/ 予算編集タブ\n- 予算キーの列を消す。/);

  // 2 本ある → 黙って選ばない
  seedFeedbackTask(root, "20261021T010000", "TASK-2026-10-21-fb2", ["別の指摘。"]);
  h = deps(azdo.fetch);
  assert.equal((await runPr({ root, config, reply: true, dryRun: true }, h.d)).exitCode, 1);
  assert.match(h.all(), /前回の報告より後のタスクが 2 本あります。--task で選んでください/);
});

test("289: --reply posts round comments on the same PR, keeps the description and screens comment, and is idempotent per task", async () => {
  const { root, config } = makeRoot();
  seedArchive(root);
  seedScreenshot(root, "before-top.png");
  seedScreenshot(root, "after-top.png");
  const azdo = fakeAzdo();
  assert.equal((await runPr({ root, config: withPr(config) }, deps(azdo.fetch).d)).kind, "created");
  const description = azdo.prs[0].description;
  const screensComment = azdo.threads.get(500)![0].comments[0].content;
  azdo.prs[0].isDraft = false; // 人間が公開した（客先レビュー中）

  // 第 1 回: その回のタスクの項目と、その回のスクショだけ（見出しの直下）
  seedFeedbackTask(root, "20261021T000000", "TASK-2026-10-21-fb1", ["予算キーの列を消す。"], ["before-edit.png", "after-edit.png"]);
  writeFileSync(path.join(root, "runs", "TASK-2026-10-21-fb1", "screenshots", "labels.json"), JSON.stringify({ edit: "実行予算作成画面 / 予算編集タブ" }), "utf8");
  let h = deps(azdo.fetch);
  let r = await runPr({ root, config: withPr(config), reply: true }, h.d);
  assert.equal(r.kind, "created", h.all());
  const reply1 = () => azdo.threads.get(500)![1].comments[0].content;
  assert.match(reply1(), /^## 指摘への対応（第 1 回）\n\n### 実行予算作成画面 \/ 予算編集タブ\n- 予算キーの列を消す。\n\n\*\*変更前\*\*\n\n!\[変更前 実行予算作成画面 \/ 予算編集タブ\]\(https:[^)]+before-edit\.[0-9a-f]{8}\.png\)/);
  assert.doesNotMatch(reply1(), /top/, "only this round's screenshots");
  assert.match(reply1(), /対応の記録: TASK-2026-10-21-fb1・生成キー: [0-9a-f]{12}/);
  assert.match(h.all(), /この PR は公開済みです。投稿したコメントは客先から見えます/);
  assert.equal(azdo.prs[0].description, description, "the published description is untouched");
  assert.equal(azdo.threads.get(500)![0].comments[0].content, screensComment, "the screens comment is untouched");

  // 同じ回をもう一度 → 変更なし（2 つ目のコメントを作らない）
  r = await runPr({ root, config: withPr(config), reply: true }, deps(azdo.fetch).d);
  assert.equal(r.kind, "unchanged");
  assert.equal(azdo.threads.get(500)!.length, 2);

  // 人がこの回のコメントを直した → 上書きしない
  azdo.threads.get(500)![1].comments[0].content = reply1().replace("- 予算キーの列を消す。", "- 予算キーの列を消す。（補足しました）");
  h = deps(azdo.fetch);
  r = await runPr({ root, config: withPr(config), reply: true, taskDir: path.join(root, "archive", "single", "20261021T000000-task") }, h.d);
  assert.equal(r.kind, "skipped");
  assert.match(h.all(), /この回のコメントは人の手で直されています/);

  // 第 2 回: 次の指摘への対応のタスク
  seedFeedbackTask(root, "20261022T000000", "TASK-2026-10-22-fb2", ["合計行を太字にする。"]);
  r = await runPr({ root, config: withPr(config), reply: true }, deps(azdo.fetch).d);
  assert.equal(r.kind, "created");
  assert.match(azdo.threads.get(500)![2].comments[0].content, /^## 指摘への対応（第 2 回）\n\n### 実行予算作成画面 \/ 予算編集タブ\n- 合計行を太字にする。/);
  assert.match(eventLog(root), /"pr\.reply"[^\n]*"action":"created"[^\n]*"round":2/);

  // PR が無いブランチ → 投稿しない
  const empty = fakeAzdo();
  h = deps(empty.fetch);
  r = await runPr({ root, config: withPr(config), reply: true, taskDir: path.join(root, "archive", "single", "20261022T000000-task") }, h.d);
  assert.equal(r.exitCode, 1);
  assert.match(h.all(), /active な PR がありません/);
  assert.deepEqual(writes(empty.calls), []);
});

// ---- 指摘の取り込み: --import-feedback（2026-10-23・設計 §I-2）-------------------------------------

const PR_THREADS = [
  // 未解決・PR 全体・複数行と返信つき → 取り込む
  {
    id: 11,
    status: "active",
    comments: [
      { id: 1, parentCommentId: 0, commentType: "text", content: "取極外タブの列の順番が違います。\n- 現在見込損益はコメントの前\n- 合計行は太字" },
      { id: 2, parentCommentId: 1, commentType: "text", content: "承知しました。確認します。" },
      { id: 3, parentCommentId: 1, commentType: "text", content: "消した返信", isDeleted: true }
    ]
  },
  // 未解決・ファイルの行に付いた指摘 → ファイルの見出しで取り込む
  { id: 12, status: "pending", threadContext: { filePath: "/src/Grid.tsx", rightFileStart: { line: 42 } }, comments: [{ id: 1, parentCommentId: 0, commentType: "text", content: "ここは右寄せに。" }] },
  // 解決済み → 除く
  { id: 13, status: "fixed", comments: [{ id: 1, parentCommentId: 0, commentType: "text", content: "直っています。" }] },
  // system → 除く
  { id: 14, comments: [{ id: 1, parentCommentId: 0, commentType: "system", content: "The reference was updated." }] },
  // aiw の画面のコメント: 本文は取り込まず、そこへの返信を 1 件ずつ取り込む（2026-10-23 実例: 画像を見ながら返信で指摘された）
  {
    id: 15,
    status: "active",
    comments: [
      { id: 1, parentCommentId: 0, commentType: "text", content: "## 画面（変更前 → 変更後）\n\nx\n\n---\nこの画面の比較はタスクの記録から自動生成しました（生成キー: 0123456789ab）。" },
      { id: 3, parentCommentId: 1, commentType: "text", content: "細い列を消してほしい。\n単位列の左にある列。" }
    ]
  },
  // 返信の無い aiw のコメント → 指摘なし
  { id: 17, status: "active", comments: [{ id: 1, parentCommentId: 0, commentType: "text", content: "## 指摘への対応（第 1 回）\n\nx\n\n---\nこの回の対応はタスクの記録から自動生成しました（対応の記録: TASK-x・生成キー: 0123456789ab）。" }] },
  // 削除されたスレッド → 除く
  { id: 16, status: "active", isDeleted: true, comments: [{ id: 1, parentCommentId: 0, commentType: "text", content: "消した指摘" }] }
];

function feedbackPr(threads = PR_THREADS) {
  return fakeAzdo({
    prs: [{ pullRequestId: 7, isDraft: false, status: "active", title: "t", description: "d", sourceRefName: "refs/heads/feature/sample", targetRefName: "refs/heads/master" }],
    seedThreads: { 7: JSON.parse(JSON.stringify(threads)) }
  });
}

test("290: --import-feedback writes the open, human PR comments into user-task.md as a checkbox draft", async () => {
  const { root, config } = makeRoot();
  const userTask = path.join(root, "user-task.md");
  copyFileSync(path.join(root, "templates", "user-task.md"), userTask); // 雛形のまま
  const before = stateBytes(root);
  const azdo = feedbackPr();

  // --dry-run: 読み取りの API だけ・書かない
  let h = deps(azdo.fetch);
  assert.equal((await runPr({ root, config: withPr(config), importFeedback: true, dryRun: true }, h.d)).kind, "dry-run");
  assert.equal(readFileSync(userTask, "utf8"), readFileSync(path.join(root, "templates", "user-task.md"), "utf8"), "dry-run does not write");
  assert.deepEqual(writes(azdo.calls), [], "only read APIs");
  // 指摘 3 件 = 人のスレッド 2 件 + 画面のコメントへの返信 1 件。指摘の無いスレッド 3 件 = 解決済み・system・返信の無い aiw のコメント
  // （削除されたスレッドは一覧の段階で除くので数えない）
  assert.match(h.all(), /未解決の指摘: 3 件（新しく取り込む 3 件・取り込み済み 0 件）／指摘の無いスレッド 3 件/);

  // 本実行: 雛形なので全体を書く
  h = deps(azdo.fetch);
  assert.equal((await runPr({ root, config: withPr(config), importFeedback: true }, h.d)).kind, "updated");
  const text = readFileSync(userTask, "utf8");
  assert.match(text, /^# User Task\n\n## PR の指摘への対応（\d{4}-\d{2}-\d{2} 取り込み）\n/);
  assert.match(
    text,
    /### PR 全体への指摘\n\n- \[ \] 取極外タブの列の順番が違います。（PR コメント #11）\n  - 現在見込損益はコメントの前\n  - 合計行は太字\n  - 返信: 承知しました。確認します。\n/
  );
  // aiw の画面のコメントへの返信は 1 件ずつ（aiw の本文は取り込まない）。PR 全体の後・ファイルの前
  assert.match(
    text,
    /  - 返信: 承知しました。確認します。\n\n### 画面のコメントへの返信\n\n- \[ \] 細い列を消してほしい。（PR コメント #15-3）\n  - 単位列の左にある列。\n\n### src\/Grid\.tsx\n/
  );
  assert.match(text, /### src\/Grid\.tsx\n\n- \[ \] ここは右寄せに。（42 行目）（PR コメント #12）\n/);
  for (const excluded of ["直っています", "The reference", "画面（変更前", "指摘への対応（第 1 回）", "消した"]) assert.ok(!text.includes(excluded), excluded);
  assert.deepEqual(writes(azdo.calls), [], "still only read APIs");
  assert.match(eventLog(root), /"pr\.feedback-imported"[^\n]*"imported":\["11","12","15-3"\]/);
  assert.equal(stateBytes(root), before, "state.json is not touched");

  // 取り込んだ下書きは依頼のチェックリストとして読める（--reply の項目の出所）
  assert.deepEqual(parseRequested(text).map((g) => [g.heading, g.items.length]), [
    ["PR 全体への指摘", 1],
    ["画面のコメントへの返信", 1],
    ["src/Grid.tsx", 1]
  ]);

  // 打ち直し: 同じ指摘は二重に入れない
  h = deps(azdo.fetch);
  assert.equal((await runPr({ root, config: withPr(config), importFeedback: true }, h.d)).kind, "unchanged");
  assert.equal(readFileSync(userTask, "utf8"), text);
});

test("291: a hand-written user-task.md gets an appended section; nothing is written without a PR or without new comments", async () => {
  const { root, config } = makeRoot();
  const userTask = path.join(root, "user-task.md");
  writeFileSync(userTask, "# User Task\n\n## 次タスク：自分で書いた依頼\n\n- [ ] 手で書いた項目。\n", "utf8");
  // 一部はもう手で写してある（印つき）→ その指摘は取り込まない
  writeFileSync(userTask, `${readFileSync(userTask, "utf8")}- [ ] 写した指摘（PR コメント #12）\n`, "utf8");
  const h = deps(feedbackPr().fetch);
  assert.equal((await runPr({ root, config: withPr(config), importFeedback: true }, h.d)).kind, "updated");
  const text = readFileSync(userTask, "utf8");
  assert.ok(text.startsWith("# User Task\n\n## 次タスク：自分で書いた依頼\n\n- [ ] 手で書いた項目。\n- [ ] 写した指摘（PR コメント #12）\n\n## PR の指摘への対応（"), "existing text is kept and the section is appended");
  assert.equal((text.match(/PR コメント #12/g) ?? []).length, 1, "#12 is not imported twice");
  assert.match(text, /（PR コメント #11）/);
  assert.match(h.all(), /末尾に節を足します/);

  // PR が無い → 書かない
  const none = fakeAzdo();
  const h2 = deps(none.fetch);
  const r = await runPr({ root, config: withPr(config), importFeedback: true }, h2.d);
  assert.equal(r.exitCode, 1);
  assert.match(h2.all(), /active な PR がありません/);
  assert.equal(readFileSync(userTask, "utf8"), text);

  assert.match(text, /（PR コメント #15-3）/, "a reply to the aiw comment is imported too");

  // 新しい指摘が無い（解決済み・system と、取り込み済みの返信だけ）→ 書かない
  const h3 = deps(feedbackPr(PR_THREADS.filter((t) => t.id >= 13)).fetch);
  assert.equal((await runPr({ root, config: withPr(config), importFeedback: true }, h3.d)).kind, "unchanged");
  assert.match(h3.all(), /新しく取り込む指摘はありません/);
  assert.equal(readFileSync(userTask, "utf8"), text);
});
