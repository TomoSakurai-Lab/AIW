// Azure DevOps REST の最小クライアント（aiw pr・docs/design-pr.md §2・§B）。
//
// **az CLI は使わない**（客先 PC への導入物を増やさない）。Node の fetch を直接叩く。
// fetch は引数で受ける（テストは偽の fetch を渡し、`--dry-run` が 1 回も呼ばないことを数える）。
//
// 仕様の出所（2026-10-20 確認・Microsoft Learn の REST リファレンス 7.1）:
//   - PR の作成 POST .../pullrequests（isDraft あり）/ 更新 PATCH .../pullrequests/{id}（Description は 4000 字まで・isDraft は更新対象外）
//   - 一覧 GET .../pullrequests は description を 400 字で切る → 本文の比較には GET .../pullrequests/{id} を使う
//   - 添付 POST .../pullRequests/{id}/attachments/{fileName}（application/octet-stream・vso.code_write）
//
// ⚠️ PAT の生の値を取り出すのは `authHeader()` の 1 箇所だけ（test 267）。エラー文は status と応答 JSON の
// `message` を 200 字までに限り、応答本文の全文・リクエストヘッダは出さない。最終段の redact は run.ts。
import type { PrSettings } from "../types.js";
import type { PatSecret } from "./secret.js";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export type AzdoTarget = {
  kind: "services" | "server";
  /** 末尾の `/` を除いた organization（Server はコレクション）URL */
  baseUrl: string;
  project: string;
  repository: string;
  apiVersion: string;
};

export const SERVICES_API_VERSION = "7.1";

export function isServicesHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
  } catch {
    return false;
  }
}

/** settings から接続先を決める。足りないキーを全部返す（1 つずつ直させない）。 */
export function resolveTarget(settings: PrSettings | undefined): { ok: true; target: AzdoTarget } | { ok: false; missing: string[] } {
  const s = settings ?? {};
  const missing: string[] = [];
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const organizationUrl = str(s.organizationUrl).replace(/\/+$/, "");
  const project = str(s.project);
  const repository = str(s.repository);
  if (!organizationUrl) missing.push("settings.pr.organizationUrl");
  if (!project) missing.push("settings.pr.project");
  if (!repository) missing.push("settings.pr.repository");
  const kind = organizationUrl && isServicesHost(organizationUrl) ? "services" : "server";
  let apiVersion = str(s.apiVersion);
  if (!apiVersion) {
    if (kind === "services") {
      apiVersion = SERVICES_API_VERSION;
    } else if (organizationUrl) {
      missing.push("settings.pr.apiVersion（Azure DevOps Server では必須。2020 = 6.0 / 2022 = 7.0 / 2022.1 以降 = 7.1）");
    }
  }
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, target: { kind, baseUrl: organizationUrl, project, repository, apiVersion } };
}

export type DerivedRemote = { organizationUrl: string; project: string; repository: string };

/**
 * git remote の URL から 3 値を導く（`aiw pr --check` の表示用。**settings へは書かない**）。
 * 対応: `https://[user@]dev.azure.com/<org>/<project>/_git/<repo>` / `https://<org>.visualstudio.com/[DefaultCollection/]<project>/_git/<repo>` /
 * `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` / Server の `https://<host>/<collection>/<project>/_git/<repo>`。
 */
export function deriveFromRemote(remoteUrl: string): DerivedRemote | null {
  const url = remoteUrl.trim();
  const dec = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const ssh = url.match(/^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/i);
  if (ssh) {
    return { organizationUrl: `https://dev.azure.com/${dec(ssh[1])}`, project: dec(ssh[2]), repository: dec(ssh[3]) };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  const gitAt = parts.indexOf("_git");
  if (gitAt < 1 || gitAt + 1 >= parts.length) {
    return null;
  }
  const repository = dec(parts[gitAt + 1]);
  const project = dec(parts[gitAt - 1]);
  const prefix = parts.slice(0, gitAt - 1).map(dec);
  const host = parsed.host.toLowerCase();
  // 利用者名（`primalinc@`）は捨てる。URL に資格情報を残さない
  if (host === "dev.azure.com") {
    if (prefix.length < 1) return null;
    return { organizationUrl: `https://dev.azure.com/${prefix[0]}`, project, repository };
  }
  if (host.endsWith(".visualstudio.com")) {
    return { organizationUrl: `https://${host}`, project, repository };
  }
  const base = [`${parsed.protocol}//${parsed.host}`, ...prefix.map((p) => encodeURIComponent(p))].join("/");
  return { organizationUrl: base, project, repository };
}

export class AzdoError extends Error {
  constructor(
    readonly stage: string,
    readonly status: number | null,
    message: string
  ) {
    super(message);
  }
}

export type AzdoRepository = { id: string; name: string; defaultBranch: string | null; webUrl: string | null };
export type AzdoPullRequest = {
  pullRequestId: number;
  isDraft: boolean;
  status: string;
  title: string;
  description: string;
  sourceRefName: string;
  targetRefName: string;
};
export type AzdoAttachment = { displayName: string; url: string };
/** スレッドと、その先頭のコメント */
export type AzdoThread = { id: number; commentId: number; content: string };

const TIMEOUT_MS = 30_000;
const MESSAGE_LIMIT = 200;

function asPullRequest(v: any): AzdoPullRequest {
  return {
    pullRequestId: Number(v?.pullRequestId),
    isDraft: v?.isDraft === true,
    status: String(v?.status ?? ""),
    title: String(v?.title ?? ""),
    description: typeof v?.description === "string" ? v.description : "",
    sourceRefName: String(v?.sourceRefName ?? ""),
    targetRefName: String(v?.targetRefName ?? "")
  };
}

export class AzdoClient {
  constructor(
    private readonly target: AzdoTarget,
    private readonly pat: PatSecret,
    private readonly fetchImpl: FetchImpl
  ) {}

  private authHeader(): string {
    return `Basic ${Buffer.from(`:${this.pat.reveal()}`, "utf8").toString("base64")}`;
  }

  private repoUrl(suffix: string, query: Record<string, string> = {}): string {
    const t = this.target;
    const q = new URLSearchParams({ ...query, "api-version": t.apiVersion });
    return `${t.baseUrl}/${encodeURIComponent(t.project)}/_apis/git/repositories/${encodeURIComponent(t.repository)}${suffix}?${q.toString()}`;
  }

  private async call(stage: string, method: string, url: string, body?: { json?: unknown; bytes?: Buffer }): Promise<any> {
    const headers: Record<string, string> = { Authorization: this.authHeader(), Accept: "application/json" };
    let payload: BodyInit | undefined;
    if (body?.json !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.bytes) {
      headers["Content-Type"] = "application/octet-stream";
      payload = new Uint8Array(body.bytes);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const e = error as { name?: string; message?: string };
      const why = e.name === "TimeoutError" || e.name === "AbortError" ? `${TIMEOUT_MS / 1000} 秒で応答なし` : (e.message ?? String(error));
      throw new AzdoError(stage, null, `${stage}: 接続できません（${why.slice(0, MESSAGE_LIMIT)}）`);
    }
    const text = await res.text().catch(() => "");
    const contentType = res.headers.get("content-type") ?? "";
    let json: any = undefined;
    if (contentType.includes("json") && text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    // ⚠️ Services は不正な PAT に 203 + HTML（サインインページ）を返すことがある。2xx でも JSON でなければ失敗にする
    if (!res.ok || res.status === 203 || (text !== "" && json === undefined)) {
      const detail =
        json && typeof json.message === "string"
          ? json.message.slice(0, MESSAGE_LIMIT)
          : res.status === 401 || res.status === 203 || json === undefined
            ? "認証に失敗した可能性があります（PAT の有効期限・スコープ Code (Read & Write)・organizationUrl を確認）"
            : "";
      throw new AzdoError(stage, res.status, `${stage}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    return json;
  }

  async getRepository(): Promise<AzdoRepository> {
    const v = await this.call("リポジトリ情報の取得", "GET", this.repoUrl(""));
    return {
      id: String(v?.id ?? ""),
      name: String(v?.name ?? ""),
      defaultBranch: typeof v?.defaultBranch === "string" ? v.defaultBranch : null,
      webUrl: typeof v?.webUrl === "string" ? v.webUrl : null
    };
  }

  /** active な PR。source / target を指定すれば絞る。 */
  async listActivePullRequests(filter: { source?: string; target?: string; top?: number } = {}): Promise<AzdoPullRequest[]> {
    const query: Record<string, string> = { "searchCriteria.status": "active" };
    if (filter.source) query["searchCriteria.sourceRefName"] = filter.source;
    if (filter.target) query["searchCriteria.targetRefName"] = filter.target;
    if (filter.top) query["$top"] = String(filter.top);
    const v = await this.call("PR 一覧の取得", "GET", this.repoUrl("/pullrequests", query));
    return Array.isArray(v?.value) ? v.value.map(asPullRequest) : [];
  }

  /** 1 件の PR（一覧と違い description が切れない）。 */
  async getPullRequest(id: number): Promise<AzdoPullRequest> {
    return asPullRequest(await this.call("PR の取得", "GET", this.repoUrl(`/pullrequests/${id}`)));
  }

  /** `refs/heads/<branch>` がリモートにあるか。 */
  async branchExists(branch: string): Promise<boolean> {
    const v = await this.call("ブランチの確認", "GET", this.repoUrl("/refs", { filter: `heads/${branch}` }));
    return Array.isArray(v?.value) && v.value.some((r: any) => r?.name === `refs/heads/${branch}`);
  }

  async createDraftPullRequest(input: { source: string; target: string; title: string; description: string }): Promise<AzdoPullRequest> {
    const v = await this.call("PR の作成", "POST", this.repoUrl("/pullrequests"), {
      json: { sourceRefName: input.source, targetRefName: input.target, title: input.title, description: input.description, isDraft: true }
    });
    return asPullRequest(v);
  }

  /** **説明文だけ**を更新する。タイトル・isDraft は送らない（人間が直した・公開した状態を機械が戻さない）。 */
  async updateDescription(id: number, description: string): Promise<AzdoPullRequest> {
    return asPullRequest(await this.call("説明文の更新", "PATCH", this.repoUrl(`/pullrequests/${id}`), { json: { description } }));
  }

  async listAttachments(id: number): Promise<AzdoAttachment[]> {
    const v = await this.call("添付の一覧", "GET", this.repoUrl(`/pullRequests/${id}/attachments`));
    return Array.isArray(v?.value)
      ? v.value
          .filter((a: any) => typeof a?.displayName === "string" && typeof a?.url === "string")
          .map((a: any) => ({ displayName: a.displayName, url: a.url }))
      : [];
  }

  /** PR のスレッド（削除されたものは除く）。各スレッドの先頭のコメントだけを返す（aiw のコメントはスレッドの先頭に 1 つ） */
  async listThreads(id: number): Promise<AzdoThread[]> {
    const v = await this.call("コメントの一覧", "GET", this.repoUrl(`/pullRequests/${id}/threads`));
    if (!Array.isArray(v?.value)) return [];
    return v.value
      .filter((t: any) => t?.isDeleted !== true && Array.isArray(t?.comments) && t.comments.length > 0)
      .map((t: any) => {
        const first = t.comments.find((c: any) => c?.isDeleted !== true && Number(c?.parentCommentId ?? 0) === 0) ?? t.comments[0];
        return { id: Number(t.id), commentId: Number(first?.id), content: typeof first?.content === "string" ? first.content : "" };
      });
  }

  /** PR 全体へのコメント（ファイルの行に付けない）を 1 つ持つスレッドを作る */
  async createThread(id: number, content: string): Promise<AzdoThread> {
    const v = await this.call("コメントの作成", "POST", this.repoUrl(`/pullRequests/${id}/threads`), {
      json: { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: 1 }
    });
    const first = Array.isArray(v?.comments) ? v.comments[0] : undefined;
    return { id: Number(v?.id), commentId: Number(first?.id ?? 1), content };
  }

  /** コメントの本文だけを更新する */
  async updateComment(id: number, threadId: number, commentId: number, content: string): Promise<void> {
    await this.call("コメントの更新", "PATCH", this.repoUrl(`/pullRequests/${id}/threads/${threadId}/comments/${commentId}`), { json: { content } });
  }

  async uploadAttachment(id: number, fileName: string, bytes: Buffer): Promise<AzdoAttachment> {
    const v = await this.call("画像の添付", "POST", this.repoUrl(`/pullRequests/${id}/attachments/${encodeURIComponent(fileName)}`), { bytes });
    if (typeof v?.url !== "string") {
      throw new AzdoError("画像の添付", null, "画像の添付: 応答に url がありません");
    }
    return { displayName: String(v.displayName ?? fileName), url: v.url };
  }
}
