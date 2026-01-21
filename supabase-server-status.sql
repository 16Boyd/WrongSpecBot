-- Create the server_status table to track WoW server online/offline status
CREATE TABLE IF NOT EXISTS server_status (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,          -- US, EU, KR, TW
    is_online BOOLEAN NOT NULL,
    last_checked TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_status_change TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    consecutive_failures INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create unique index on region to ensure one row per region
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_status_region ON server_status(region);

-- Enable Row Level Security
ALTER TABLE server_status ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow all operations
CREATE POLICY "Allow all operations on server_status"
ON server_status
FOR ALL
USING (true)
WITH CHECK (true);

-- Create the server_status_history table to track status changes over time
CREATE TABLE IF NOT EXISTS server_status_history (
    id SERIAL PRIMARY KEY,
    region TEXT NOT NULL,
    is_online BOOLEAN NOT NULL,
    changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    duration_seconds INTEGER,      -- How long the previous status lasted
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create index for querying history
CREATE INDEX IF NOT EXISTS idx_server_status_history_region ON server_status_history(region);
CREATE INDEX IF NOT EXISTS idx_server_status_history_changed_at ON server_status_history(changed_at);

-- Enable Row Level Security for history
ALTER TABLE server_status_history ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow all operations on history
CREATE POLICY "Allow all operations on server_status_history"
ON server_status_history
FOR ALL
USING (true)
WITH CHECK (true);

-- Create the server_status_settings table for Discord notifications
CREATE TABLE IF NOT EXISTS server_status_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    channel_id TEXT,               -- Discord channel for notifications
    notify_on_offline BOOLEAN DEFAULT true,
    notify_on_online BOOLEAN DEFAULT true,
    watched_realm TEXT,            -- Specific realm to watch (e.g., "Tichondrius")
    watched_realm_region TEXT DEFAULT 'US',  -- Region of watched realm (US, EU, KR, TW)
    watched_realm_online BOOLEAN DEFAULT true, -- Current status of watched realm
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security for settings
ALTER TABLE server_status_settings ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow all operations on settings
CREATE POLICY "Allow all operations on server_status_settings"
ON server_status_settings
FOR ALL
USING (true)
WITH CHECK (true);

-- Insert default settings row
INSERT INTO server_status_settings (id, channel_id, notify_on_offline, notify_on_online)
VALUES ('default', NULL, true, true)
ON CONFLICT (id) DO NOTHING;

-- Insert initial status rows for each region
INSERT INTO server_status (region, is_online, consecutive_failures)
VALUES 
    ('US', true, 0),
    ('EU', true, 0),
    ('KR', true, 0),
    ('TW', true, 0)
ON CONFLICT (region) DO NOTHING;
