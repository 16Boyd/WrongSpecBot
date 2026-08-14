import supabase from './supabase';
import { errorToLogMetadata, consoleLog, LogLike } from './logger';

export interface DatabaseNotificationSettings {
    id: string;
    channel_id: string;
    sell_threshold: number;
    hold_threshold: number;
    last_action: string | null;
    last_notified: string | null;
    message_id: string | null;
    current_price: number | null;
    created_at: string;
    updated_at: string;
}

// Load the single notification_settings row (id = 'default'). Returns null if missing or on error.
export async function loadNotificationSettingsRow(logger: LogLike = consoleLog): Promise<DatabaseNotificationSettings | null> {
    const { data, error } = await supabase
        .from('notification_settings')
        .select('*')
        .eq('id', 'default')
        .single<DatabaseNotificationSettings>();

    if (error && error.code !== 'PGRST116') { // PGRST116 is "not found"
        logger.error('Error loading notification settings', errorToLogMetadata(error));
        return null;
    }

    return data ?? null;
}

// Upsert a partial notification_settings row. 'id' is always forced to 'default'.
export async function saveNotificationSettingsRow(
    row: Partial<Omit<DatabaseNotificationSettings, 'id'>>,
    logger: LogLike = consoleLog
): Promise<boolean> {
    const { error } = await supabase
        .from('notification_settings')
        .upsert({ id: 'default', ...row }, { onConflict: 'id' });

    if (error) {
        logger.error('Error saving notification settings', errorToLogMetadata(error));
        return false;
    }

    return true;
}
