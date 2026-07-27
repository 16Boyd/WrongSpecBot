-- Create the amp_instance_status table for tracking a single AMP game-server instance
-- and the Discord message that displays its live status.
CREATE TABLE IF NOT EXISTS amp_instance_status (
    id TEXT PRIMARY KEY DEFAULT 'default',
    channel_id TEXT,             -- Discord channel to post the status message in
    instance_id TEXT,            -- AMP InstanceID (GUID) of the instance to watch
    message_id TEXT,             -- Discord message ID, so the message can be edited/replaced
    last_status TEXT,            -- Fingerprint of the last-rendered message (avoids needless edits)
    title TEXT,                  -- Embed title (falls back to the instance name if null)
    description_template TEXT,   -- Embed body. Supports {status} {userCount} {maxUsers} {state}
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migration: add the template columns to an existing table
ALTER TABLE amp_instance_status ADD COLUMN IF NOT EXISTS title TEXT;
ALTER TABLE amp_instance_status ADD COLUMN IF NOT EXISTS description_template TEXT;

-- Enable Row Level Security
ALTER TABLE amp_instance_status ENABLE ROW LEVEL SECURITY;

-- NOTE: This policy grants full read/write to anyone holding the anon key. It relies on
-- SUPABASE_ANON_KEY being kept server-side only (never shipped to a client in this project).
CREATE POLICY "Allow all operations on amp_instance_status"
ON amp_instance_status
FOR ALL
USING (true)
WITH CHECK (true);

-- Insert the default settings row with an example template. Set channel_id and instance_id to
-- activate the feature, then edit title / description_template to taste. {status} and {userCount}
-- (plus {maxUsers} and {state}) are replaced with live values on every update.
INSERT INTO amp_instance_status (id, title, description_template)
VALUES (
    'default',
    'Palworld',
    E'### Connection Info\n**Community Server Name:** Wrong Spec\n**Domain:** your.domain.here\n**Port:** 8211\n**Password:** your_password\n\n### Server Stats:\n**Status:** {status}\n**Users:** {userCount}/32\n\n### Modified Server Settings\n- Friendly Fire Enabled\n- Backup Daily\n- Server Pauses when the last user logs off.'
)
ON CONFLICT (id) DO NOTHING;
