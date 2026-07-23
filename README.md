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


## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) - free to use, modify, and share for any noncommercial purpose.