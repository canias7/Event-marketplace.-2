# Connecting the Neon database

## The idea in one sentence

Your Neon connection string contains your database password, so it lives in a
file git ignores (`.env.local`), and your code looks it up by the name
`DATABASE_URL` instead of containing it directly.

---

## Step 1 — Copy the connection string from Neon

1. Open your project at <https://console.neon.tech>
2. Click the **Connect** button in the top navigation
3. A box opens titled *"Connect to your branch"*
4. Leave **Connection pooling** switched **ON**
5. Click the copy icon to copy the string

It will look like this (one long line):

```
postgresql://neondb_owner:npg_AbC123xyz@ep-cool-name-12345678-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require
```

Then do it a **second time** with **Connection pooling switched OFF**. That
gives you a second, slightly different string — the hostname loses the
`-pooler` part. You need both:

| String | Hostname has `-pooler` | Used for |
|---|---|---|
| Pooled | yes | the app, while it's running |
| Direct | no | creating and changing tables |

## Step 2 — Create your local env file

In the project folder:

```bash
cp .env.example .env.local
```

Open `.env.local` and replace the two example values with your real strings:

- `DATABASE_URL` → the **pooled** one
- `DATABASE_URL_UNPOOLED` → the **direct** one

Keep the quotes around them.

## Step 3 — Prove it works

```bash
psql "$(grep '^DATABASE_URL=' .env.local | cut -d= -f2- | tr -d '"')" -c "SELECT version();"
```

If you see a line starting with `PostgreSQL 17...`, the database is connected.

If you get `could not translate host name`, the string got cut off when pasting.
If you get `password authentication failed`, re-copy it from the Neon console.

## Step 4 — Add the same values to your host later

`.env.local` only exists on your own machine. When this app is deployed
(Vercel, Netlify, Railway, etc.), you paste the same two values into that
service's **Environment Variables** settings page. Deploys cannot read
`.env.local`, so a missing variable there is the usual cause of "works
locally, broken in production".

---

## Rules

- **Never** commit `.env.local`. `.gitignore` already blocks it.
- **Never** paste the connection string into a `.ts`/`.js` file, a README, a
  GitHub issue, or a chat message.
- If it does leak, reset the password in Neon: **Branches → Roles → Reset
  password**. The old string stops working immediately.
