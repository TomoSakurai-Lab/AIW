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
import { buildDescription, DESCRIPTION_LIMIT, isUntouchedByHuman, scrub } from "../src/engine/pr/describe.js";
import { runPr, type PrDeps } from "../src/engine/pr/run.js";
import { readPrSource } from "../src/engine/pr/source.js";
import type { WorkflowConfig } from "../src/engine/types.js";
import { archivedTaskDirs, makeRoot, runReflection, setStep, validTaskMetadata, writeIn, writeStatus } from "./helpers.js";

// ---- fixtures ---------------------------------------------------------------------------------

const TASK_ID = "TASK-2026-10-20-sample";

const FILES: Record<string, string> = {
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

function seedScreenshot(root: string, name = "after-top.png"): string {
  const dir = path.join(root, "runs", TASK_ID, "screenshots");
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
} = {}) {
  const calls: Call[] = [];
  const prs: FakePr[] = [...(opts.prs ?? [])];
  const attachments = new Map<number, Array<{ displayName: string; url: string }>>();
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
  return { fetch, calls, prs, attachments };
}

function deps(fetch: FetchImpl, env: NodeJS.ProcessEnv = { AZURE_DEVOPS_PAT: "test-pat-value" }, branch = "feature/sample") {
  const out: string[] = [];
  const err: string[] = [];
  const d: PrDeps = {
    fetch,
    env,
    git: (_repoRoot, args) => {
      if (args[0] === "rev-parse") return `${branch}\n`;
      if (args[0] === "rev-list") return "0\n";
      if (args[0] === "remote") return "https://primalinc@dev.azure.com/primalinc/BizForecast%20for%20%E6%9D%B1%E6%80%A5%E5%BB%BA%E8%A8%AD/_git/Template.toukyu\n";
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l)
  };
  return { d, out, err, all: (): string => [...out, ...err].join("\n") };
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
  const older = buildDescription({ ...readPrSource(root, dir), metadata: { summary: "前のフェーズ", featureName: "x", taskName: "t", featureId: "F" } }, []);
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
    ["human-edited", [{ ...base, pullRequestId: 2, isDraft: true, description: mine.replace("## 概要\n", "## 概要\n人が足した一文。\n") }]],
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
  seedScreenshot(root);
  const azdo = fakeAzdo({ failAttach: () => new Response(JSON.stringify({ message: "boom" }), { status: 500, headers: { "content-type": "application/json" } }) });
  const before = stateBytes(root);
  const h = deps(azdo.fetch);
  const r = await runPr({ root, config: withPr(config) }, h.d);
  assert.equal(r.kind, "created", h.all());
  assert.equal(r.exitCode, 0);
  const created = azdo.calls.filter((c) => c.method === "POST" && c.path.endsWith("/pullrequests"));
  assert.equal(created.length, 1);
  assert.equal(created[0].body.isDraft, true, "always draft");
  assert.match(azdo.prs[0].description, /\.ai-workflow\/runs\/TASK-2026-10-20-sample\/screenshots\/after-top\.png/);
  assert.match(eventLog(root), /"pr\.attachment-failed"/);
  assert.match(h.all(), /公開前に確認/);
  assert.equal(stateBytes(root), before);

  // 添付が成功する場合: 作成 → 添付 → 説明文に画像
  const { root: root2, config: config2 } = makeRoot();
  seedArchive(root2);
  seedScreenshot(root2);
  const ok = fakeAzdo();
  assert.equal((await runPr({ root: root2, config: withPr(config2) }, deps(ok.fetch).d)).kind, "created");
  assert.match(ok.prs[0].description, /!\[top\]\(https:\/\/dev\.azure\.com\/org\/_apis\/attachments\/after-top\.[0-9a-f]{8}\.png\)/);
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
  }
  assert.equal(azdo.calls.length, 0, "fetch was never called");
  assert.equal(eventLog(root), logBefore);
  assert.equal(stateBytes(root), stBefore);
});

test("265: missing artifacts are written as 'no record', never as zero or as verified", async () => {
  const { root, config } = makeRoot();
  seedArchive(root, { omit: ["current-review.md", "context-package.md", "current-result.md", "task-metadata.json"] });
  const h = deps(fakeAzdo().fetch);
  await runPr({ root, config, dryRun: true }, h.d);
  const text = h.all();
  for (const phrase of ["タスクの要約の記録なし", "変更ファイルの記録なし", "検査の記録なし", "受け入れ条件: 記録なし", "手動での確認が必要な項目: 記録なし", "レビュー記録なし"]) {
    assert.ok(text.includes(phrase), `missing: ${phrase}\n${text}`);
  }
  assert.doesNotMatch(text, /確認済み \d/);
  assert.doesNotMatch(text, /重大な指摘 0 件/);

  // review がテンプレートのまま
  const { root: r2, config: c2 } = makeRoot();
  const dir2 = seedArchive(r2);
  copyFileSync(path.join(r2, "templates", "current-review.md"), path.join(dir2, "current-review.md"));
  const h2 = deps(fakeAzdo().fetch);
  await runPr({ root: r2, config: c2, dryRun: true }, h2.d);
  assert.match(h2.all(), /レビュー記録なし（記録が空のまま）/);

  // context-package の無い古い archive は実装報告へ落ち、見出しで区別する
  const { root: r3, config: c3 } = makeRoot();
  seedArchive(r3, { omit: ["context-package.md"] });
  const h3 = deps(fakeAzdo().fetch);
  await runPr({ root: r3, config: c3, dryRun: true }, h3.d);
  assert.match(h3.all(), /## 変更したファイル（実装報告による・事前宣言の記録なし）\n- `src\/a\.tsx`/);
});

test("266: an oversized record is trimmed in stages with an explicit note; if it still does not fit, no PR is made", async () => {
  const { root, config } = makeRoot();
  const many = Array.from({ length: 20 }, (_, i) => `- 手動確認 ${i} ${"あ".repeat(150)}`).join("\n");
  const backlog = Array.from({ length: 20 }, (_, i) => `### BL-${900 + i}\n- Summary: ${"い".repeat(200)}。\n`).join("\n");
  const dir = seedArchive(root, {
    override: {
      "task-metadata.json": JSON.stringify({ featureName: "f", summary: "う".repeat(3000) }),
      "current-result.md": FILES["current-result.md"].replace("- 画面で罫線の色を目視する。理由は自動化できないため。", many),
      "current-review.md": FILES["current-review.md"].replace(/### BL-900[\s\S]*?- Status: open\n/, backlog)
    }
  });
  const d = buildDescription(readPrSource(root, dir), []);
  assert.equal(d.overLimit, false);
  assert.ok(d.chars <= DESCRIPTION_LIMIT, `${d.chars}`);
  assert.ok(d.truncations.length > 0);
  assert.match(d.description, /以下省略。全文はタスクの記録を参照/);
  assert.ok(isUntouchedByHuman(d.description), "trimmed text still carries its key");

  // パスが極端に長いと、全段を締めても収まらない → 作らない
  const longFiles = Array.from({ length: 40 }, (_, i) => `- \`src/${"d".repeat(300)}/${i}.tsx\``).join("\n");
  seedArchive(root, { stamp: "20261021T000000", override: { "context-package.md": `# Files\n\n## Modify\n\n${longFiles}\n` } });
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
  writeStatus(root, { step: "reflection", result: "feature-complete", reason: "done" });
  assert.equal(runReflection(root, config).kind, "transitioned");
  const h = deps(fakeAzdo().fetch);
  const r = await runPr({ root, config, dryRun: true }, h.d);
  assert.equal(r.kind, "dry-run");
  assert.match(h.all(), new RegExp(`（${TASK_ID}）`));
  assert.match(h.all(), /## 変更したファイル\n- `src\/first\.tsx`/);
  // implementation / fix が走っていないタスクなので、検査の記録は無いと書く（済みと書かない）
  assert.match(h.all(), /突き合わせ: 検査の記録なし/);
});
