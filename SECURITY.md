# Security Policy

## Supported versions

Only the latest stable release receives security fixes.

| Version | Supported |
| --- | --- |
| Latest stable `0.x` release | Yes |
| Earlier stable releases | No — upgrade to the latest release |
| `alpha` / `rc` pre-releases | No — published for testing only |

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/SiriLee/dsh-rewind/security/advisories/new)**
— or open **Security** → **Report a vulnerability** from the repository. It
creates a private advisory that only you and the maintainer can see.

Please do not open a public issue, pull request, or discussion for a
vulnerability before a fix has been released.

Include as much of the following as you can:

- the plugin version or commit;
- the DeepSeek Harness version (`@deepseek-ai/*` packages);
- the platform and Node.js version;
- a minimal reproduction: configuration, steps, and the relevant log output;
- whether the failure happened before or after a workspace file was mutated.

If the problem is in DSH itself or in another plugin, report it to that project.

## What to expect

- We aim to acknowledge a report within 7 days, with a first assessment
  (in scope / out of scope / need more information) within a further 7 days.
- The report stays private while a fix is developed, and you are kept updated in
  the advisory.
- We ask for up to 90 days before public disclosure; the advisory can be
  published earlier once a fix is ready and you agree.
- With your consent, the published advisory credits you, and it enters the
  GitHub Advisory Database so `npm audit` and Dependabot can flag affected
  installs.
- If the report is not a vulnerability, or is out of scope, we explain why and
  close the advisory.

## Scope

**In scope** — behavior that breaks a guarantee in the security model:

- a restore that writes outside the paths and locations the session recorded, or
  that runs without an explicit user action;
- path traversal, or a symlink/hard-link escape, through a session id, a
  checkpoint row, or restore planning;
- rewriting, deleting, or truncating the session log, or otherwise changing
  recorded history;
- a restore crossing sessions, or touching a path the session's own tools did
  not record;
- a crash, a corrupt checkpoint, or a missing/wrong-sized recorded version that
  loses a live file or lets unrecorded state be written back;
- parsing, modifying, or deleting old-format snapshot data instead of leaving it
  to whole-session cleanup;
- a hostile session-log entry or tool argument escaping the containment that
  document describes.

**Out of scope**:

- attackers who already have the same OS account, the host process, or the
  workspace: the host user is trusted, and store files use the process umask;
- vulnerabilities in DSH or other plugins — report them upstream;
- actions the model is allowed to take under DSH's permission model (for
  example, editing a `.env` file), unless they escape that model;
- behavior the security model explicitly lists as a non-goal.

## Security model

The guarantees, the containment rules, and the explicit non-goals are
documented at
**https://github.com/SiriLee/dsh-rewind/blob/main/docs/security-model.md**.

Reporters are welcome to test those claims: a mismatch between that document and
the code is itself worth reporting.
