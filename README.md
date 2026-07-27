# WrongSpecBot

A Discord bot for tracking World of Warcraft token prices with real-time notifications and alerts.

## Features

- 📊 Real-time WoW Token price tracking
- 🔔 Customizable price threshold notifications
- 🌍 Multi-region support for the `/token` command (US, EU, KR, TW); automated alerts track one configurable region (`WATCH_REGION`, default US)
- ⚡ Automatic price checking on a schedule (driven by a Cloudflare Worker cron)
- 🖥️ Live AMP game-server instance status in Discord, with a one-click **Start Server** button
- 📱 Discord slash commands
- 🔒 Secure data storage with Supabase

## Available Commands

- `/token [region]` - Get current WoW Token price for a specific region
- `/notify <channel> <sell_threshold> <hold_threshold>` - Set up price alerts
- `/ping` - Check if the bot is responsive

## Quick Start

1. **Clone the repository**
```bash
git clone https://github.com/jasonb194/WrongSpecBot.git
cd WrongSpecBot
```

2. **Install dependencies**
```bash
npm install
```

3. **Set up environment variables** (see detailed setup sections below)

4. **Deploy commands**
```bash
npm run deploy
```

5. **Start the bot**
```bash
# Development mode with auto-reload
npm run dev

# Production mode
npm start
```

---

# 🚀 Complete Setup Guide

## 1. Discord Bot Setup

### Step 1: Create Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **"New Application"**
3. Enter a name for your bot (e.g., "WoW Token Tracker")
4. Click **"Create"**

### Step 2: Create Bot User

1. In your application, go to the **"Bot"** section in the left sidebar
2. Click **"Add Bot"**
3. Customize your bot:
   - **Username**: Set your bot's display name
   - **Avatar**: Upload a bot avatar image
   - **Public Bot**: Turn OFF if you want only you to invite the bot

### Step 3: Get Bot Token

1. In the **"Bot"** section, under **"Token"**
2. Click **"Reset Token"** (or **"Copy"** if it's your first time)
3. **⚠️ IMPORTANT**: Copy this token immediately and save it securely
4. Never share this token publicly

### Step 4: Configure Bot Permissions

1. Go to **"OAuth2"** → **"URL Generator"** in the left sidebar
2. Under **"Scopes"**, select:
   - ✅ `bot`
   - ✅ `applications.commands`
3. Under **"Bot Permissions"**, select:
   - ✅ `Send Messages`
   - ✅ `Read Message History`
   - ✅ `Use Slash Commands`
   - ✅ `Embed Links`
4. Copy the generated URL at the bottom

### Step 5: Invite Bot to Server

1. Open the copied URL in your browser
2. Select the Discord server you want to add the bot to
3. Verify the permissions and click **"Authorize"**
4. Complete the CAPTCHA if prompted

---

## 2. Blizzard API Setup

### Step 1: Create Blizzard Developer Account

1. Go to [Blizzard Developer Portal](https://develop.battle.net/)
2. Log in with your Battle.net account
3. Accept the API Terms of Service

### Step 2: Create API Client

1. Click **"Create Client"**
2. Fill in the details:
   - **Client Name**: "WoW Token Bot" (or your preferred name)
   - **Intended Use**: Select "Desktop/Mobile App"
   - **Redirect URLs**: Leave empty for this bot
3. Click **"Create"**

### Step 3: Get API Credentials

1. After creating the client, you'll see:
   - **Client ID**: Copy this value
   - **Client Secret**: Copy this value
2. **⚠️ IMPORTANT**: Keep these credentials secure

---

## 3. Supabase Setup

### Step 1: Create Supabase Project

1. Go to [Supabase](https://supabase.com/)
2. Click **"Start your project"**
3. Sign up/in with GitHub (recommended)
4. Click **"New Project"**
5. Fill in project details:
   - **Organization**: Select or create one
   - **Name**: "wow-token-bot" (or preferred name)
   - **Database Password**: Generate a strong password
   - **Region**: Choose closest to your users (e.g., US East)
6. Click **"Create new project"**

### Step 2: Set Up Database

1. Wait for project creation to complete
2. Go to **"SQL Editor"** in the left sidebar
3. Copy the contents of `supabase-setup.sql` from this repository
4. Paste into the SQL editor and click **"Run"**
5. Repeat for `supabase-server-status.sql` (realm status) and `supabase-amp-status.sql` (AMP instance status) to create those tables

### Step 3: Get Project Credentials

1. Go to **"Settings"** → **"API"** in the left sidebar
2. Copy these values:
   - **Project URL**: `https://your-project.supabase.co`
   - **Anon/Public Key**: `eyJ...` (long string starting with eyJ)

### Step 4: Configure Row Level Security (Optional but Recommended)

1. Go to **"Authentication"** → **"Policies"**
2. The setup script already includes basic policies
3. For production, consider more restrictive policies based on your needs

---

## 4. Vercel Deployment

### Step 1: Prepare for Deployment

1. Ensure your code is pushed to GitHub
2. Your repository should be public or accessible to Vercel

### Step 2: Deploy to Vercel

1. Go to [Vercel](https://vercel.com/)
2. Sign up/in with GitHub
3. Click **"New Project"**
4. Import your GitHub repository
5. Configure project:
   - **Framework Preset**: Other
   - **Root Directory**: `./` (leave default)
   - **Build Command**: `npm run build` (or leave empty)
   - **Output Directory**: Leave empty
   - **Install Command**: `npm install`

### Step 3: Add Environment Variables

In Vercel project settings, add these environment variables:

```
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
DISCORD_PUBLIC_KEY=your_discord_public_key
BLIZZARD_CLIENT_ID=your_blizzard_client_id
BLIZZARD_CLIENT_SECRET=your_blizzard_client_secret
SUPABASE_URL=your_supabase_project_url
SUPABASE_ANON_KEY=your_supabase_anon_key
CRON_SECRET=a_long_random_shared_secret
AUTHORIZED_USERS=comma_separated_discord_user_ids
DEFAULT_CHANNEL_ID=optional_fallback_channel_id
WATCH_REGION=US
AMP_URL=https://your-amp-panel:8080
AMP_USERNAME=your_amp_username
AMP_PASSWORD=your_amp_password
AMP_INSECURE_TLS=true   # only if AMP uses a self-signed HTTPS certificate
```

### Step 4: Deploy

1. Click **"Deploy"**
2. Wait for deployment to complete
3. Your bot API will be available at `https://your-project.vercel.app`

### Step 5: Scheduling

Scheduling is handled by the Cloudflare Worker in `cloudflare-cron/` (see section 5), which calls
the `/api/check-prices`, `/api/server-status`, and `/api/amp-status` endpoints on a schedule with the
shared `CRON_SECRET` bearer token. A native Vercel Cron Job is **not** used, because it would not send the
bearer token these endpoints now require.

---

## 5. Cloudflare Worker (Cron) Setup

The scheduler lives in `cloudflare-cron/`. It triggers the price-check, server-status, and AMP-status
endpoints on a schedule and authenticates with the `CRON_SECRET` shared secret.

### Step 1: Configure

1. `cd cloudflare-cron`
2. Review `wrangler.toml` — set the cron schedule under `[triggers]` (defaults to every minute) and
   confirm the `account_id`.

### Step 2: Set Secrets/Variables

1. `npx wrangler secret put CRON_SECRET` — use the **same** value you set in Vercel.
2. Set `VERCEL_BASE_URL` (e.g. `https://your-project.vercel.app`) as a variable/secret.

### Step 3: Deploy

1. `npm install`
2. `npm run deploy` (runs `wrangler deploy`)

The worker will now call `/api/check-prices`, `/api/server-status`, and `/api/amp-status` on the
configured schedule. Each request includes `Authorization: Bearer <CRON_SECRET>`; requests without a
valid token are rejected with `401`.

---

## 5a. AMP Instance Status Setup

This feature posts a live status message for one or more AMP (CubeCoders Application Management Panel)
game-server instances and keeps them updated. Each instance is a separate row in the
`amp_instance_status` table with its own channel, title, and template. When an instance is stopped, its
message includes a green **Start Server** button that calls the AMP API to boot it — handy when the
instance is configured to auto-stop once the last player leaves.

The embed's title and body are **fully author-controlled** via a template stored in Supabase, so you can
include static details AMP doesn't expose (community server name, domain, password, house rules) alongside
live values. The following placeholders are substituted on every update:

| Placeholder   | Replaced with                                             |
| ------------- | --------------------------------------------------------- |
| `{status}`    | `Online` / `Offline` / a transitional label (`Starting`…) |
| `{userCount}` | current online player count                               |
| `{maxUsers}`  | maximum player slots (from AMP metrics)                   |
| `{state}`     | raw AMP state label (`Ready`, `Stopped`, …)               |

### Step 1: Provide AMP credentials

Set `AMP_URL`, `AMP_USERNAME`, and `AMP_PASSWORD` in Vercel (used by both the scheduled `/api/amp-status`
endpoint and the button handler in `/api/interactions`). Use an AMP account with permission to view and
start the instance. `AMP_URL` is the base panel URL, e.g. `https://amp.example.com` or `http://1.2.3.4:8080`.

If AMP is served over **HTTPS with a self-signed certificate**, also set `AMP_INSECURE_TLS=true`. Node
rejects self-signed certificates by default (you'd see `Client network socket disconnected before secure
TLS connection was established` or a certificate error); this flag skips certificate verification for AMP
requests only. All other outbound TLS (Discord, Blizzard, Supabase) stays fully verified.

### Step 2: Configure instances in Supabase

The feature is inactive until at least one instance is configured. **Add one row per instance** in the
`amp_instance_status` table (the setup SQL includes an example `INSERT` you can duplicate). Each row has:

- `instance_id` — the AMP **InstanceID** (a GUID) of the instance to watch (primary key)
- `channel_id` — the Discord channel where this instance's status message should be posted
- `title` (optional) — embed title; defaults to the instance's friendly name if left blank
- `description_template` (optional) — the embed body; the setup SQL seeds an example you can edit

To find the InstanceID, open the instance in AMP and copy the GUID from its URL, or call
`ADSModule/GetInstances` and read the `InstanceID` field.

Each run performs a single AMP login + `GetInstances` and then updates every configured row, so adding
more instances doesn't multiply the AMP API calls. The worker posts each status message on its next run
and edits it in place whenever that instance's status changes. Anyone in the channel can press **Start
Server** — this is intentional, since the point is to let players bring an auto-stopped server back
online.

When someone presses **Start Server**, the status message immediately shows `Start Requested` until the
next check reflects the real state, and the private "Start requested" confirmation shown to that user is
auto-dismissed a few minutes later (the `ephemeral_message_cleanup` table, created by the setup SQL,
tracks these — the every-minute cron performs the delayed deletion, since serverless functions can't
wait). AMP has two layers: the instance *daemon* (started via `ADSModule/StartInstance`) and the game
*application* inside it (started via the instance's own `Core/Start`, which needs an instance-scoped
login). The button starts both.

---

## 6. Environment Variables

Create a `.env` file in your project root with all required variables:

```env
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_client_id_here
# From the Discord Developer Portal (General Information > Public Key); required to verify interaction requests
DISCORD_PUBLIC_KEY=your_discord_public_key_here

# Blizzard API Configuration
BLIZZARD_CLIENT_ID=your_blizzard_client_id_here
BLIZZARD_CLIENT_SECRET=your_blizzard_client_secret_here

# Supabase Configuration
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key_here

# Cron authentication (shared secret between the Cloudflare Worker and the API endpoints)
CRON_SECRET=a_long_random_shared_secret

# Comma-separated Discord user IDs allowed to run /notify (use IDs, not usernames)
AUTHORIZED_USERS=123456789012345678,234567890123456789

# Optional: region the automated price checker watches (US, EU, KR, TW). Defaults to US.
WATCH_REGION=US

# Optional: fallback channel ID used by the price checker if none is configured via /notify
DEFAULT_CHANNEL_ID=your_channel_id_here

# AMP (CubeCoders Application Management Panel) — required only for the AMP instance status feature
AMP_URL=https://your-amp-panel:8080
AMP_USERNAME=your_amp_username
AMP_PASSWORD=your_amp_password
# Set to true ONLY if AMP is served over HTTPS with a self-signed certificate. Skips TLS
# certificate verification for AMP requests only (Discord/Blizzard/Supabase stay verified).
AMP_INSECURE_TLS=true
```

**⚠️ Security Note**: Never commit your `.env` file to version control. It's already included in `.gitignore`.

---

## 7. Testing Your Setup

### Test Discord Bot

1. Use `/token` to test Blizzard API integration
2. Use `/notify` to test Supabase integration

### Test API Endpoints

1. Trigger the endpoint with the bearer token (a plain browser visit returns `401`):
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" https://your-project.vercel.app/api/check-prices
   ```
2. Check Vercel logs for any errors
3. Check the Cloudflare Worker logs (`npx wrangler tail` in `cloudflare-cron/`) to confirm scheduled runs

### Test Database

1. In Supabase dashboard, go to **"Table Editor"**
2. Check the `notification_settings` table for your data
3. Verify data is being saved when you use `/notify`

---

## 8. Troubleshooting

### Common Issues

**Bot not responding to commands:**
- Check Discord token is correct
- Ensure bot has proper permissions in server
- Verify bot is online in Discord

**API errors:**
- Check Blizzard API credentials
- Verify Supabase connection and credentials
- Check Vercel logs for detailed error messages

**Database issues:**
- Ensure Supabase table was created properly
- Check Row Level Security policies
- Verify environment variables are set correctly

### Getting Help

- **GitHub Issues**: [https://github.com/jasonb194/WrongSpecBot/issues](https://github.com/jasonb194/WrongSpecBot/issues)
- **Documentation**: Check our [Terms of Service](./TERMS_OF_SERVICE.md) and [Privacy Policy](./PRIVACY_POLICY.md)

---

## 📚 Additional Resources

- [Discord.js Documentation](https://discord.js.org/#/docs)
- [Blizzard API Documentation](https://develop.battle.net/documentation)
- [Supabase Documentation](https://supabase.com/docs)
- [Vercel Documentation](https://vercel.com/docs)

## 🛠️ Technology Stack

- **Runtime**: Node.js
- **Bot Framework**: Discord.js v14
- **Database**: Supabase (PostgreSQL)
- **Hosting**: Vercel
- **Monitoring**: UptimeRobot
- **APIs**: Blizzard Battle.net API

## 📄 License

This project is licensed under the ISC License - see the [LICENSE](./WrongSpecBot/LICENSE) file for details. 