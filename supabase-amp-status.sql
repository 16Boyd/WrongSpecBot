-- Create the amp_instance_status table. One row per AMP game-server instance you want to
-- display in Discord; each row tracks its own channel, message, and description template.
CREATE TABLE IF NOT EXISTS amp_instance_status (
    instance_id TEXT PRIMARY KEY,   -- AMP InstanceID (GUID) of the instance to watch
    channel_id TEXT,                -- Discord channel to post this instance's status message in
    message_id TEXT,                -- Discord message ID, so the message can be edited/replaced
    last_status TEXT,               -- Fingerprint of the last-rendered message (avoids needless edits)
    title TEXT,                     -- Embed title (falls back to the instance name if null)
    description_template TEXT,      -- Embed body. Supports {status} {userCount} {maxUsers} {state}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

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
-- {userCount} (plus {maxUsers} and {state}) are replaced with live values on every update.
-- Duplicate this INSERT for each instance you want to display.
INSERT INTO amp_instance_status (instance_id, channel_id, title, description_template)
VALUES (
    'REPLACE_WITH_AMP_INSTANCE_GUID',
    'REPLACE_WITH_DISCORD_CHANNEL_ID',
    'Palworld',
    E'### Connection Info\n**Community Server Name:** Wrong Spec\n**Domain:** your.domain.here\n**Port:** 8211\n**Password:** your_password\n\n### Server Stats:\n**Status:** {status}\n**Users:** {userCount}/32\n\n### Modified Server Settings\n- Friendly Fire Enabled\n- Backup Daily\n- Server Pauses when the last user logs off.'
)
ON CONFLICT (instance_id) DO NOTHING;
