# Release

## First release (manual, one-time)

Trusted Publisher can only be configured once the package exists, so the first
version is published locally:

```sh
npm login
npm publish --access public
```

- If prompted for `EOTP`: complete the browser auth link the CLI prints, or
  retry with a 6-digit code — `npm publish --otp=<code>`.
- The first version carries no provenance (local path) — acceptable; every CI
  release after that publishes with Sigstore/SLSA provenance automatically.

## Configure Trusted Publisher (npmjs.com, one-time)

Open `https://www.npmjs.com/package/dsh-rewind-plugin` → package **settings** →
**Trusted Publisher**:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `SiriLee` |
| Repository | `dsh-rewind` (the GitHub repo, not the npm name) |
| Workflow filename | `publish.yml` |
| Environment | empty |
| Allowed actions | `npm publish` |

## Subsequent releases (CI, automatic)

```sh
npm version patch
git push origin main --tags   # triggers .github/workflows/publish.yml
```

- The workflow verifies the tag matches `package.json`, runs typecheck + tests +
  a full build + artifact verification, publishes with `--provenance`
  (Sigstore), and creates a GitHub Release. It is **idempotent** — an already
  published version is skipped.
- CI (`.github/workflows/ci.yml`) runs the same checks on every push / PR, plus
  a `npm pack --dry-run` sanity check that the tarball carries `lib/` and
  `LICENSE`.

---

# 发布流程

## 首次发布（手动，一次性）

Trusted Publisher 要求**包已存在**才能配置，因此首个版本走本地发布：

```sh
npm login
npm publish --access public
```

- 若提示 `EOTP`（一次性密码）：按 CLI 输出的浏览器认证链接完成认证，或用
  authenticator 的 6 位码 `npm publish --otp=<code>` 重试。
- 首个版本无 provenance（本地路径），合规；之后每次 CI 发布自动带
  Sigstore/SLSA provenance。

## 配置 Trusted Publisher（npmjs.com，一次性）

打开 `https://www.npmjs.com/package/dsh-rewind-plugin` → 包右上角 **settings**
→ **Trusted Publisher**：

| 字段 | 值 |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `SiriLee` |
| Repository | `dsh-rewind`（GitHub 仓库名，与 npm 包名可不同） |
| Workflow filename | `publish.yml` |
| Environment | 留空 |
| Allowed actions | `npm publish` |

## 后续发布（CI 自动）

```sh
npm version patch
git push origin main --tags   # 触发 .github/workflows/publish.yml
```

- workflow 校验 tag 与 `package.json` 版本一致，跑 typecheck + 测试 + 完整
  构建 + 产物验证，以 `--provenance`（Sigstore）发布并创建 GitHub Release。
  **幂等**——已发布的版本会跳过。
- CI（`.github/workflows/ci.yml`）在每次 push / PR 跑相同检查，外加
  `npm pack --dry-run` 校验 tarball 含 `lib/` 与 `LICENSE`。
