-- Create the amp_instance_status table for tracking a single AMP game-server instance
-- and the Discord message that displays its live status.
CREATE TABLE IF NOT EXISTS amp_instance_status (
    id TEXT PRIMARY KEY DEFAULT 'default',
    channel_id TEXT,           -- Discord channel to post the status message in
    instance_id TEXT,          -- AMP InstanceID (GUID) of the instance to watch
    message_id TEXT,           -- Discord message ID, so the message can be edited/replaced
    last_status TEXT,          -- Fingerprint of the last-rendered status (avoids needless edits)
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

-- Insert the default settings row. Set channel_id and instance_id to activate the feature.
INSERT INTO amp_instance_status (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;
