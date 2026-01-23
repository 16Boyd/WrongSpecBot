-- Create the server_status_settings table for realm tracking
CREATE TABLE IF NOT EXISTS server_status_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    channel_id TEXT,
    notify_on_offline BOOLEAN DEFAULT true,
    notify_on_online BOOLEAN DEFAULT true,
    watched_realm TEXT,
    watched_realm_region TEXT DEFAULT 'US',
    watched_realm_online BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE server_status_settings ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow all operations
CREATE POLICY "Allow all operations on server_status_settings"
ON server_status_settings
FOR ALL
USING (true)
WITH CHECK (true);

-- Insert default settings row
INSERT INTO server_status_settings (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;
