# Security Policy

Capsuleers.IA is a **local-first desktop application**: the AI runs on your machine
(Electron + `node-llama-cpp`), with no account, no server, and no telemetry. Nothing
leaves the machine except **optional, read-only lookups to public EVE Online APIs**
(ESI, eve-kill, EVE-Scout) that you explicitly trigger. We take the integrity of the
app, of the data it downloads, and of your machine seriously, and we appreciate
responsible disclosure.

## Supported Versions

The project is pre-1.0 and ships as a rolling release. **Only the latest published
release** receives security fixes — desktop builds auto-update on launch, so please
update before reporting. Older AppImages / installers are not patched.

| Version | Supported |
|---|---|
| Latest release (current `0.1.x`) | ✅ |
| Any older release | ❌ |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security problems.**

Report privately, by either channel:

1. **GitHub Security Advisories (preferred):** open a private report at
   <https://github.com/WilliamFalci/capsuleers.ia/security/advisories/new>.
2. **Email:** <info@capsuleers.app> — put `SECURITY` in the subject. Encrypt with a
   PGP key on request if the finding is sensitive.

Please include, as far as you can:

- the affected component (desktop app / ingestion pipeline / index or model download /
  IPC / chat rendering) and version;
- your OS + how you installed (AppImage, Windows installer, source);
- a clear reproduction (steps, PoC, or a minimal input — e.g. a crafted fit/scan,
  a malicious update manifest, a hostile API response);
- the impact you believe it has.

### What to expect

- **Acknowledgement** within **72 hours**.
- An initial **assessment** within **7 days**.
- A fix or mitigation timeline communicated after triage; we aim to ship fixes for
  confirmed high-severity issues in the next release.
- **Credit** in the release notes / advisory if you want it (or anonymity if you
  prefer). We follow **coordinated disclosure**: please give us a reasonable window
  (target **90 days**) before any public write-up.

## Scope

**In scope** — issues in *this repository's* code and release artifacts:

- the **desktop app** ([`desktop/`](desktop/)): IPC surface, Electron configuration
  (context isolation, remote content), rendering of model output / citations
  (XSS / HTML injection in answers), local file handling;
- the **download & update path**: tampering with the knowledge **index** or **GGUF
  models**, manifest/signature/`sha256` integrity bypass (see
  [`RELEASING.md`](RELEASING.md) / `desktop/src/assets-manifest.json`), TLS / origin
  issues, path traversal on extraction;
- the **ingestion pipeline** ([`ingestion/`](ingestion/)): injection or unsafe parsing
  of third-party source content (wikis, missions, static sites) that could compromise
  the build host or poison the index;
- handling of untrusted input fed to the app (EFT fits, D-Scan/Local pastes, and
  responses from the public EVE APIs it calls).

**Out of scope:**

- vulnerabilities in **third-party dependencies** with no exploit path through this
  app — report those upstream (Dependabot already tracks our deps);
- the security of **CCP's ESI**, **eve-kill**, **EVE-Scout**, **Fandom**, **Ollama**,
  **Qdrant**, or the LLM/embedding models themselves;
- the **content/accuracy** of AI answers (a wrong fit assessment is a bug, not a
  vulnerability) and model hallucinations;
- attacks that require a **already-compromised machine**, physical access, or a
  malicious OS/admin;
- **denial-of-service against public EVE APIs** — do not stress-test third-party
  services while researching;
- social engineering, missing security headers on marketing pages, and self-XSS.

## Security model & guarantees

- **No accounts, no auth, no analytics, no tracking.** The app stores its data under
  the OS user-data dir; it does not phone home.
- **Egress is opt-in and read-only:** only the public EVE APIs listed above, only when
  you run a feature that needs them. See [`THIRD_PARTY.md`](THIRD_PARTY.md) for the full
  list of external services and their licences.
- **Release integrity:** the index/model manifest carries per-file `sha256` so the app
  can verify downloads; report any way to bypass that check.
- This software is provided "as is", without warranty, under the
  [MIT License](LICENSE). This policy describes how we handle reports; it is not a
  warranty or a guarantee of a fix.

Thank you for helping keep capsuleers safe. o7
