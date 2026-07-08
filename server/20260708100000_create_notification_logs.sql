-- Create Notification Logs Table
CREATE TABLE IF NOT EXISTS public.notification_logs (
    id SERIAL PRIMARY KEY,
    ticket_number VARCHAR(13) NOT NULL,
    recipient VARCHAR(100) NOT NULL,
    channel VARCHAR(20) NOT NULL, -- 'email' | 'rocketchat' | 'inapp'
    status VARCHAR(20) NOT NULL, -- 'sent' | 'failed' | 'mocked'
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_notif_logs_ticket ON public.notification_logs(ticket_number);
