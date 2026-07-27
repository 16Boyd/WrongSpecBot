-- Create the amp_instance_status table. One row per AMP game-server instance you want to
-- display in Discord; each row tracks its own channel, message, and description template.
CREATE TABLE IF NOT EXISTS amp_instance_status (
    instance_id TEXT PRIMARY KEY,   -- AMP InstanceID (GUID) of the instance to watch
    channel_id TEXT,                -- Discord channel to post this instance's status message in
    message_id TEXT,                -- Discord message ID, so the message can be edited/replaced
    last_status TEXT,               -- Fingerprint of the last-rendered message (avoids needless edits)
    title TEXT,                     -- Embed title (falls back to the instance name if null)
    description_template TEXT,      -- Embed body. Supports {status} {userCount} {maxUsers} {state} {domain} {port}
    port INTEGER,                   -- Port to show for {port}. Set per row: games expose several
                                    --   ports (game/query/RCON/…) and AMP doesn't say which to display.
    start_requested_at TIMESTAMP WITH TIME ZONE,  -- Set when Start Server is pressed. Grace window:
                                    --   while recent and the app is still offline, the cron keeps the
                                    --   "Start Requested" message instead of reverting to Offline.
    start_pending BOOLEAN DEFAULT FALSE,  -- Set true when Start Server is pressed; cleared once a
                                    --   start has been performed. If the button's background start
                                    --   attempt was frozen by the serverless runtime, the cron sees
                                    --   this flag and performs the start itself (guaranteed fallback).
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- For existing installs created before these columns were added (safe to run repeatedly).
ALTER TABLE amp_instance_status ADD COLUMN IF NOT EXISTS port INTEGER;
ALTER TABLE amp_instance_status ADD COLUMN IF NOT EXISTS start_requested_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE amp_instance_status ADD COLUMN IF NOT EXISTS start_pending BOOLEAN DEFAULT FALSE;

-- Enable Row Level Security
ALTER TABLE amp_instance_status ENABLE ROW LEVEL SECURITY;

-- NOTE: This policy grants full read/write to anyone holding the anon key. It relies on
-- SUPABASE_ANON_KEY being kept server-side only (never shipped to a client in this project).
CREATE POLICY "Allow all operations on amp_instance_status"
ON amp_instance_status
FOR ALL
USING (true)
WITH CHECK (true);

-- Example: add one row per instance. instance_id is the AMP InstanceID (GUID). {status} and
-- {userCount} (plus {maxUsers}, {state}, {domain}, {port}) are replaced with live values on every
-- update. {domain} comes from the AMP_URL host; {port} comes from this row's `port` column (set it
-- to the port you want players to use). {split} breaks the body into side-by-side columns (each
-- chunk becomes an inline embed field), which keeps the message shorter vertically. Here everything
-- before {split} is the left column and everything after is the right column. Duplicate this INSERT
-- for each instance you want to display.
INSERT INTO amp_instance_status (instance_id, channel_id, title, port, description_template)
VALUES (
    'REPLACE_WITH_AMP_INSTANCE_GUID',
    'REPLACE_WITH_DISCORD_CHANNEL_ID',
    'Palworld',
    8211,
    E'### Connection Info\n**Community Server Name:** Wrong Spec\n**Domain:** {domain}\n**Port:** {port}\n**Password:** your_password\n\n### Server Stats\n**Status:** {status}\n**Users:** {userCount}/32\n\n{split}\n\n### Modified Server Settings\n- Friendly Fire Enabled\n- Backup Daily\n- Server Pauses when the last user logs off.'
)
ON CONFLICT (instance_id) DO NOTHING;

-- Queue of ephemeral "Start requested" confirmation messages awaiting deletion. The button
-- handler inserts a row (with the interaction token and a delete_at a few minutes out); the
-- amp-status cron deletes each due message and removes its row. Serverless functions can't
-- sleep for minutes, so the every-minute cron performs the delayed cleanup.
CREATE TABLE IF NOT EXISTS ephemeral_message_cleanup (
    id BIGSERIAL PRIMARY KEY,
    application_id TEXT NOT NULL,       -- Discord application ID
    interaction_token TEXT NOT NULL,    -- interaction token (authorises the delete; ~15 min TTL)
    delete_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE ephemeral_message_cleanup ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all operations on ephemeral_message_cleanup"
ON ephemeral_message_cleanup
FOR ALL
USING (true)
WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_ephemeral_cleanup_delete_at ON ephemeral_message_cleanup(delete_at);
