# Security Policy

## Supported versions

Only the latest release (see [CHANGELOG.md](CHANGELOG.md) / Releases) receives security fixes. Older
versions are not patched; upgrade instead.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository
(`https://github.com/JiamingShi-JsPhys/dsh-token-steward/security/advisories/new`). Include the
affected version, the platform (Windows / macOS / Linux), and a minimal reproduction. You can expect
an acknowledgement within about a week. This is a single-maintainer project, so please allow a
reasonable window before public disclosure.

## Threat model

The plugin runs on the user's own machine and spends the user's own upstream keys. Three attackers
are worth defending against:

1. **A web page the user visits.** It can send requests to `127.0.0.1`, and a DNS-rebinding trick can
   make its own origin resolve to loopback. It must not be able to read the gateway token, change
   routing, or make the plugin send a stored key anywhere.
2. **Another local account / a backup or sync service.** `~/.dsh` is often copied to cloud storage,
   committed to a dotfiles repo, or attached to a bug report.
3. **A malicious upstream / relay the user added.** It sees its own key (unavoidable), but must not
   receive any *other* vendor's key, and must not be able to redirect a credential-bearing request.

Malware already running **as the same user** is out of scope: it can read the key file, the
environment, and the process memory. Nothing in a local process can prevent that, and this document
does not pretend otherwise.

## Since 1.2.0

### Encryption at rest

- **Vendor API keys** in `$DSH_HOME/token-steward/vendors.json` are stored as
  `enc:v1:<iv>.<tag>.<ciphertext>` (AES-256-GCM, random IV per value). Plaintext exists only in
  memory while a request is dispatched.
- **The gateway token** in `gateway.json` is stored the same way. Port, base URL and model ids stay
  readable so wiring problems remain debuggable.
- **Cached response bodies** in `cache.sqlite` are sealed with the same key. The cache key was
  already a SHA-256 fingerprint, never the prompt itself; now the stored content is unreadable too.
- The key lives in `$DSH_HOME/token-steward/.vault-key` (0600, generated on first use). Set
  `STEWARD_VAULT_KEY` (base64url, 32 bytes) to keep the key elsewhere or to make a backup portable.
- Files are created with `0600` at `open()` time (not chmod afterwards), so there is no window where
  a world-readable temp file holds a secret. On Windows the mode is advisory; ACL inheritance from
  `%USERPROFILE%` is what protects the directory.
- Old plaintext files keep working: a key read as plaintext is re-written as ciphertext on the next
  save. A ciphertext that cannot be decrypted (key replaced, file edited) is **preserved verbatim**
  and shown as "no key" — a failed read never erases the stored secret.

### Panel API (loopback is not authentication)

Every `/api/token-steward/*` route now requires all of:

- a loopback peer address **and** a loopback `Host` header — DNS rebinding presents the attacker's
  hostname in `Host`, so it fails even though the socket is local;
- `Origin`, when present, byte-equal to `http(s)://<Host>`;
- `Sec-Fetch-Site`, when present, equal to `same-origin` or `none`;
- `Content-Type: application/json` on every POST/PUT — a cross-site "simple request" cannot set it
  without a preflight, and the plugin sends no CORS headers, so the preflight fails.

### Credential egress

- A saved vendor key is only ever sent to that vendor's own saved endpoint host. Asking the discovery
  endpoint to probe a *different* host no longer borrows the stored key.
- Model discovery no longer accepts the key in a query string (`?api_key=`); it must arrive in the
  `x-steward-upstream-key` header, which does not end up in access logs or browser history.
- Discovery URLs must be `http`/`https`, must not embed credentials, and link-local / cloud-metadata
  addresses (`169.254.0.0/16`, `fe80::/10`, `metadata.google.internal`, `0.0.0.0`) are refused.
  Loopback stays allowed — local Ollama / LM Studio relays are a legitimate use.
- Across a cross-host redirect, discovery drops `Authorization`, `x-api-key` and `Cookie`, and refuses
  an `https → http` downgrade. Chat completions do not follow redirects at all (`redirect: 'error'`):
  the body is the whole conversation and the header is a key.

### Leakage

- Gateway error responses are redacted: upstream 401 bodies that echo the key are masked before they
  reach the client (and therefore before they reach a transcript or another model). Internal 500s
  return a generic message; details go to the log, redacted.
- Every host log argument passes through the same redaction.
- `syncToHarness` no longer writes a plaintext `apiKey:` into `cordis.patch.yml`. `llm-pi-ai` only
  reads `apiKeyEnv`, so that copy never did anything except sit in a file that gets backed up. Keys
  already present in a profile are left untouched.
- Writing the gateway token into `HKCU\Environment` is now **opt-in** (`syncTokenEnv: true`). It used
  to be unconditional, which made the token visible on `reg.exe`'s command line and inherited by every
  process the user started afterwards.

## Existing controls

- The gateway binds `127.0.0.1` only, on a system-assigned or configured port, and requires
  `Authorization: Bearer <token>` for everything except `/health`. The token is 32 random bytes
  (base64url) and is compared with `timingSafeEqual` over SHA-256 digests.
- Failed authentication is rate limited per peer (20 failures per minute → `429`); successful
  authentication clears the counter. Model discovery is capped at 60 calls per minute because every
  call carries a vendor key off the machine.
- User-controlled map keys (`__proto__`, `constructor`, `prototype`) are rejected instead of being
  written into plain objects.
- The panel never returns a plaintext key: `GET /vendors` returns `hasKey` plus the last four
  characters, and snapshots/ledgers contain ids, counts and costs only.
- Request bodies are bounded (8 MiB on the gateway, 8–256 KiB on panel routes); upstream error bodies
  are read with a 64 KiB cap; discovery responses are capped at 4 MiB.
- The plugin sends no telemetry and makes no outbound request the user did not configure.

## Out of scope

- The behaviour, pricing, availability or terms of third-party upstream providers.
- Misconfiguration that places credentials in plain environment variables or in upstream provider
  settings.
- An attacker who already executes code as the same OS user.

---

## 中文说明

1.2.0 起，磁盘上的密钥是**真加密**的：

- `vendors.json` 里的厂家密钥、`gateway.json` 里的本地令牌、`cache.sqlite` 里的缓存正文，
  一律 AES-256-GCM（每个值独立随机 IV），明文只活在内存里；
- 钥匙在 `$DSH_HOME/token-steward/.vault-key`（0600），也可用 `STEWARD_VAULT_KEY` 放到别处；
- 老版本留下的明文文件照常能读，下次保存自动变成密文；解不开的密文会原样保留，不会被抹掉。

面板 API 不再只靠「来自 127.0.0.1」：还要求 `Host` 是回环名（挡 DNS rebinding）、`Origin` 同源、
跨站请求头出局、写操作必须是 `application/json`（挡 CSRF）。

出站也收紧了：已保存的密钥只发给它自己的上游地址；发现端点不再接受 `?api_key=`；
跨主机重定向会丢掉 `Authorization`；云元数据地址（169.254.x.x）直接拒绝。

**边界**：这层加密防的是「配置文件单独流出」（备份、同步盘、贴给别人、被工具整份读走）。
它不防已经能以你的身份运行代码的恶意软件——那种情况下钥匙文件同样可读。我们不会在文档里
把这一点说得比实际更强。
