-- Create the notification_settings table
CREATE TABLE IF NOT EXISTS notification_settings (
    id TEXT PRIMARY KEY DEFAULT 'default',
    channel_id TEXT,
    sell_threshold NUMERIC,
    hold_threshold NUMERIC,
    last_action TEXT,
    last_notified TIMESTAMP WITH TIME ZONE,
    message_id TEXT, -- Store the Discord message ID for editing
    current_price NUMERIC, -- Track the current price
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;

-- NOTE: This policy grants full read/write to anyone holding the anon key. It provides no
-- real protection on its own -- it relies on SUPABASE_ANON_KEY being kept server-side only
-- (it is never shipped to a client in this project). Tighten to service_role if that changes.
CREATE POLICY "Allow all operations on notification_settings"
ON notification_settings
FOR ALL
USING (true)
WITH CHECK (true);

-- Create an index on the id column (though it's already the primary key)
CREATE INDEX IF NOT EXISTS idx_notification_settings_id ON notification_settings(id);

-- Insert a default row if none exists
INSERT INTO notification_settings (id, channel_id, sell_threshold, hold_threshold, last_action, last_notified, message_id, current_price)
VALUES ('default', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- Create the logs table for application logging
CREATE TABLE IF NOT EXISTS logs (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    function_name TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security for logs table
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

-- Create a policy to allow all operations on logs
CREATE POLICY "Allow all operations on logs"
ON logs
FOR ALL
USING (true)
WITH CHECK (true);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);
CREATE INDEX IF NOT EXISTS idx_logs_function_name ON logs(function_name); 