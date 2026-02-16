# db-query

safe SQL execution for openclaw agents. postgres, mysql, sqlite. read-only by default. always.

i got tired of telling the agent to "run this sql for me" through exec and hoping it didn't drop a table. now it can't. read-only by default. always.

day 5 of [20 days of claw](https://github.com/StressTestor).

## what it does

gives your openclaw agent direct database access with safety rails. query databases, inspect schemas, run migrations if you explicitly allow it.

three drivers: sqlite (built-in via node:sqlite), postgres (pg package), mysql (mysql2 package). only install what you use.

## setup

```bash
# in your openclaw workspace
openclaw plugin add db-query

# postgres users
npm install pg

# mysql users
npm install mysql2

# sqlite works out of the box on node 22+
```

## config

add to your `openclaw.json` under `plugins`:

```json
{
  "db-query": {
    "connections": {
      "local": {
        "driver": "sqlite",
        "path": "~/.openclaw/memory/vault.db"
      },
      "prod": {
        "driver": "postgres",
        "connectionString": "$POSTGRES_URL",
        "readOnly": true
      }
    },
    "defaultConnection": "local",
    "maxRows": 1000,
    "queryTimeout": 30000,
    "allowMutations": false
  }
}
```

connection strings support `$ENV_VAR` expansion. keep secrets in env vars, not config files.

## tools

### db_query

execute SQL, get results back as table, json, or csv.

```
query: "SELECT name, email FROM users WHERE active = true"
connection: "prod"
format: "table"
limit: 50
```

### db_schema

list tables or describe a specific table's columns, types, and constraints.

```
connection: "local"
table: "memories"
```

omit `table` to list all tables.

### db_connections

list configured connections and their current status. never shows connection strings or credentials.

## slash command

```
/db SELECT * FROM users LIMIT 10
```

quick query against the default connection.

## cli

```bash
openclaw db query "SELECT * FROM users LIMIT 10"
openclaw db schema
openclaw db schema --table users
openclaw db connections
```

## safety

this is the important part.

- **read-only by default.** INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE are all blocked unless you explicitly set `allowMutations: true` globally or `readOnly: false` per connection.
- **per-connection override.** set `readOnly: true` on your prod connection and `readOnly: false` on dev. global config is the fallback.
- **query timeout.** long-running queries get killed after `queryTimeout` ms (default 30s).
- **row limit.** never returns more than `maxRows` (default 1000, hard cap 10000). individual queries can request less via the `limit` param.
- **no credential leaks.** connection strings are never included in tool responses. the `db_connections` tool masks them.
- **env var expansion.** `$POSTGRES_URL` in your config resolves from `process.env`. unexpanded vars throw a clear error.

### what this is NOT

this tool runs user-provided SQL. the agent IS the user. the safety layer prevents accidental destructive operations — it's not an SQL injection defense. the agent can run whatever SELECT it wants. that's the point.

if you don't trust the agent with your database, don't give it the connection string.

## drivers

| driver | package | notes |
|--------|---------|-------|
| sqlite | node:sqlite | built into node 22+. zero deps. |
| postgres | pg | install with `npm install pg` |
| mysql | mysql2 | install with `npm install mysql2` |

postgres and mysql are optional peer dependencies. you only need to install the one you use. if you try to use a driver without its package installed, you get a clear error telling you what to install.

## edge cases handled

- missing env var in connection string → clear error naming the variable
- sqlite file doesn't exist → creates it (with parent dirs)
- zero rows → "No results." not an empty table
- huge text columns → truncated at 200 chars
- binary/blob columns → shows `[BLOB N bytes]`
- NULL values → displayed as `NULL`
- connection failures → helpful error (wrong password? host unreachable? file not found?)
- table names with special characters → properly quoted in schema queries

## license

MIT
