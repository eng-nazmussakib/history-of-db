# Neon

Runs the normal migrations and seeds against a hosted [Neon](https://neon.com) database instead of local PostgreSQL. Nothing outside this folder is Neon-specific: `setup.sh` gets a connection string from the Neon CLI and hands it to `../scripts/migrate.sh` as `DATABASE_URL`.

```
neon/
├── config.env    # Which Neon project / branch / database to target (not secret)
└── setup.sh      # Creates the database if missing, then runs scripts/migrate.sh
```

`setup.sh` also writes `history-of-db/.env.production`: the direct `DATABASE_URL` with credentials. It's git-ignored, and `scripts/migrate.sh` doesn't read it, so plain local runs still use local Postgres. To run something else against Neon, pass it explicitly: `psql "$(grep ^DATABASE_URL= .env.production | cut -d= -f2- | tr -d '"')"`.

## One-time setup

```bash
npm install -g neon@latest   # Node 22.20+
neon login                   # opens the browser
```

## Commands

From `history-of-db/`:

| Command | What it does |
|---|---|
| `neon/setup.sh` | Creates the Neon database if missing and applies pending migrations |
| `neon/setup.sh --seed` | Same, then loads every seed (takes about 5 minutes over the network) |
| `neon/setup.sh --reset --seed` | Drops and recreates the Neon database first (**destroys its data**) |
| `neon/setup.sh --url` | Prints the connection string (and refreshes `.env.production`) |

Override the target per run: `NEON_BRANCH=dev neon/setup.sh --seed`. The branch must already exist (`neon branches create --project-id <id> --name dev`).

## Current target

| | |
|---|---|
| Project | `history-of-db` (`summer-snow-40001533`), `aws-ap-southeast-1`, PostgreSQL 18 |
| Branch | `production` |
| Database | `neondb`, the branch's default database |

The target is `neondb` because the app gets its connection strings from `neon deploy` / `neon env pull` (see below), and those always point at the branch's default database. An earlier `history_of` database on the same branch holds an identical copy from the first setup and isn't used by the app.

## Pointing the app at Neon

`history-of-app` is linked to this project (its `.neon` and `neon.ts`). Run `neon deploy` there to write `DATABASE_URL` (pooled, used by the app) and `DATABASE_URL_UNPOOLED` (direct) into `history-of-app/.env.local`. `setup.sh` here always uses the direct URL, which is the right one for migrations.

Open a shell on the database with `psql "$(neon/setup.sh --url)"`.
