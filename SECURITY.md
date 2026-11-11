# Security Policy

## Supported versions

Only the latest release (see [CHANGELOG.md](CHANGELOG.md) / Releases) receives security fixes. Older
versions are not patched; upgrade instead.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository
(`https://github.com/JiamingShi-JsPhys/dsh-token-steward/security/advisories/new`).

Include the affected version, the platform (Windows / macOS / Linux), and a minimal reproduction.
You can expect an acknowledgement within about a week. This is a single-maintainer project, so please
allow a reasonable window before public disclosure.

## How the plugin handles secrets

The plugin runs an OpenAI-compatible gateway on the user's machine, so its security model is worth
stating explicitly:

- **Bind address.** The gateway listens on `127.0.0.1` only, on a system-assigned port (`0`), so it
  never collides with an existing service and is not reachable from the local network by default.
- **Authentication.** Each start generates a random local token. Every request must carry
  `Authorization: Bearer <token>`; requests without it are rejected.
- **On-disk material.** The token and port are written to `$DSH_HOME/token-steward/gateway.json`
  with `0600` permissions. The gateway token is mirrored into the host's credential store under
  `STEWARD_TOKEN_ENV` so the host's provider config can reference it by name.
- **Upstream keys.** Vendor API keys entered in the settings page are stored in
  `$DSH_HOME/token-steward/vendors.json` with `0600` permissions. That file is **not encrypted** —
  it is treated at the same level as DSH's own credential files. The keys are used only for
  outbound calls to the upstream endpoints the user configured; they are never sent anywhere else
  and are not written to logs or crash reports.
- **Network egress.** The only outbound traffic is to the upstream endpoints in the user's model
  matrix, plus the model/pricing lookups the user triggers from the settings page.
- **No telemetry.** The plugin does not collect or upload usage data.

## Out of scope

- The behaviour, pricing, availability or terms of third-party upstream providers — report those to
  the provider.
- Misconfiguration that exposes credentials the user themselves placed in plain environment
  variables or in upstream provider settings.

## 中文说明

安全问题请**不要**开公开 issue，请用仓库的 **Security → Report a vulnerability** 私下报告。
插件只在 `127.0.0.1` 上起网关、每次启动生成随机令牌并要求 `Authorization: Bearer`，令牌与端口
以 `0600` 写在 `$DSH_HOME/token-steward/gateway.json`。厂家密钥以**明文**存放在
`$DSH_HOME/token-steward/vendors.json`（`0600`，**不是加密存储**，与 DSH 自己的凭据文件同级），
只用于访问你自己配置的上游地址，不写入日志、不上报任何遥测。
