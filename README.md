<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/art/logo-landscape-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="public/art/logo-landscape-light.png" />
    <img src="public/art/logo-landscape-light.png" alt="Saturn" width="560" />
  </picture>
</p>

## Saturn | By Wilcus Industries

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

Postgres missing? Install it first:

```shell
# macOS
brew install postgresql@17 pgvector && brew services start postgresql@17
# Debian/Ubuntu
sudo apt install -y postgresql postgresql-17-pgvector
```

The dashboard has no authentication in self-hosted mode, so keep it on
localhost. For remote access use [Tailscale](https://tailscale.com) or a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
with Access in front.

> [!WARNING]
> Linux sandboxes are not yet supported on self-hosted installs — support is
> coming soon. Everything else works; sandbox tools just report
> "sandbox runtime not configured".

> [!NOTE]
> GitHub event nodes poll by default (up to a few minutes of delay). For
> instant delivery, register your own GitHub App and point it at your
> instance — see the runbook in
> [`deploy/README.md`](deploy/README.md). Requires a publicly reachable
> webhook URL (e.g. a Cloudflare Tunnel).


## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) - free to use, modify, and share for any noncommercial purpose.