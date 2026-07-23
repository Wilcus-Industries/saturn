<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/art/logo-landscape-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="public/art/logo-landscape-light.png" />
    <img src="public/art/logo-landscape-light.png" alt="Saturn" width="560" />
  </picture>
</p>

## Saturn

No-code workflows for everything.

Create:

- Agentic automations
- Discord/Telegram bots
- Content creation workflows
- So much more

With:

- Persistent Linux sandboxes
- Persistent `pgvector`-based agent memory 
- No-code node based workflows
- And more

## Setup

Either use the official [Wilcus Industries deployment](https://saturn.wilcus.com)
or self-host Saturn on your own machine (macOS or Linux):

```shell
curl -fsSL https://raw.githubusercontent.com/Wilcus-Industries/saturn/main/install.sh | bash
```

The installer checks prerequisites (Node 22+, git, npm, psql, openssl — it never
installs system packages itself), clones the repo to `~/saturn`, picks a Postgres
database (local server or any pasted connection URL; `pgvector` is required for
the persistent agent memory), writes `.env.local` for single-owner
`SELF_HOSTED=1` mode with auto-generated secrets, runs the migrations and build,
and optionally installs a background service (macOS LaunchAgent / Linux systemd
user unit) so Saturn starts on login. Re-running it is safe.

Postgres missing? Quickest local install:

```shell
# macOS
brew install postgresql@17 pgvector && brew services start postgresql@17
# Debian/Ubuntu
sudo apt install -y postgresql postgresql-17-pgvector
```

Flags (pass as `bash -s -- <flags>`): `--dir <path>` install directory,
`--no-service` skip the background service, `--branch <name>` test an unmerged
branch. Already cloned? `bash install.sh` from inside the checkout skips the
clone step.

> **Security:** the dashboard has no authentication in self-hosted mode — anyone
> who can reach the port is the owner. Keep it bound to localhost, or put
> reverse-proxy auth in front before exposing it.

### Remote access

Two good paths, in order of preference:

- **[Tailscale](https://tailscale.com)** — don't expose the port at all; reach
  `http://<machine>:3000` from your own devices over the tailnet. The network is
  the auth, so there is nothing else to configure (`tailscale serve` adds HTTPS
  if you want it). Tailscale is what I personally use.
- **[Caddy](https://caddyserver.com)** — if you want a public URL. Auto-HTTPS
  plus built-in basic auth (`caddy hash-password` generates the hash):

  ```
  saturn.example.com {
      basic_auth {
          you $2a$14$...hash...
      }
      reverse_proxy localhost:3000
  }
  ```

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
with Access in front also works well (no open inbound port, email/SSO gate) —
it is what the official deployment runs behind — but takes more setup than
either option above.


## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) - free to use, modify, and share for any noncommercial purpose.