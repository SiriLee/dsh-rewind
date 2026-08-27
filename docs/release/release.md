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

## DSH 版本适配（peer 范围维护）

DSH 仍在 rc 阶段，npm 的 prerelease 匹配规则要求 peer 范围与宿主版本
**同 `[major, minor, patch]` 元组**才能匹配。因此 peerDependencies 采用
OR 并集覆盖 DSH 已发布的每个 rc 元组系列（如 `^0.1.0-rc.6 || ^0.1.1-rc.2`），
并随 DSH 发版追加。

- **何时需要更新**：仅当 DSH 发布新元组（`0.1.1 → 0.1.2 → 0.2.x`）时；
  同元组内 rc 滚动（`0.1.1-rc.2 → rc.3`）无需动作。DSH 所有包同版本发布，
  `npm view @deepseek-ai/dsh version` 即权威信号。
- **自动检测**：`node scripts/check-dsh-version.mjs` 对比 npm 最新版本与
  peer 覆盖的元组，输出是否需追加（exit 0 无需动作，exit 1 需要）。
- **更新步骤**：给每个 `@deepseek-ai/dsh-*` peer 追加 `|| ^<新元组>-rc.<n>`
  → devDependencies 同步升到最新 → `npm install` → `npm run typecheck` /
  `npm test` / `npm run verify:host` → 发版。
- **正式版后收敛**：DSH 发布 final 版本后，正式版不受 prerelease 元组规则
  限制，peer 可收敛为稳定的 `^0.1.x` 单范围，此节即可删除。
