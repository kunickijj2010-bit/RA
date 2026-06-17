const { db } = require('./database');

async function getSettings() {
  // Default values from process.env if settings.json / database doesn't exist
  let settings = {
    smtp_host: process.env.SMTP_HOST || '',
    smtp_port: process.env.SMTP_PORT || '587',
    smtp_secure: process.env.SMTP_SECURE === 'true',
    smtp_user: process.env.SMTP_USER || '',
    smtp_pass: process.env.SMTP_PASS || '',
    smtp_from: process.env.SMTP_FROM || '',
    rocketchat_url: process.env.ROCKETCHAT_URL || '',
    rocketchat_token: process.env.ROCKETCHAT_TOKEN || '',
    rocketchat_user: process.env.ROCKETCHAT_USER || '',
    rocketchat_channel: process.env.ROCKETCHAT_CHANNEL || '#refund-alerts',
    google_sheets_webhook: process.env.GOOGLE_SHEETS_WEBHOOK || ''
  };

  try {
    const { data, error } = await db
      .from('system_settings')
      .select('*')
      .eq('id', 1)
      .single();
      
    if (error) {
      console.warn("⚠️ System settings query failed, falling back to process.env defaults:", error.message);
      return settings;
    }

    if (data) {
      // Merge values, overriding defaults only if the database value is not null/empty
      const dbSettings = {};
      for (const key of Object.keys(data)) {
        if (data[key] !== null && data[key] !== undefined && data[key] !== '') {
          // Special case: handle secure boolean field correctly
          if (key === 'smtp_secure') {
            dbSettings[key] = data[key] === true || data[key] === 'true';
          } else {
            dbSettings[key] = data[key];
          }
        }
      }
      settings = { ...settings, ...dbSettings };
    }
  } catch (e) {
    console.error("⚠️ Error fetching settings from DB:", e.message);
  }
  return settings;
}

async function saveSettings(newSettings) {
  try {
    const currentSettings = await getSettings();
    
    // Merge new settings. If password is unchanged (comes as masked), preserve old password
    const merged = { ...currentSettings, ...newSettings };
    
    if (newSettings.smtp_pass === '••••••••') {
      merged.smtp_pass = currentSettings.smtp_pass;
    }
    if (newSettings.rocketchat_token === '••••••••') {
      merged.rocketchat_token = currentSettings.rocketchat_token;
    }

    const updateData = {
      smtp_host: merged.smtp_host || null,
      smtp_port: merged.smtp_port || '587',
      smtp_secure: merged.smtp_secure === 'true' || merged.smtp_secure === true,
      smtp_user: merged.smtp_user || null,
      smtp_pass: merged.smtp_pass || null,
      smtp_from: merged.smtp_from || null,
      rocketchat_url: merged.rocketchat_url || null,
      rocketchat_token: merged.rocketchat_token || null,
      rocketchat_user: merged.rocketchat_user || null,
      rocketchat_channel: merged.rocketchat_channel || '#refund-alerts',
      google_sheets_webhook: merged.google_sheets_webhook || null,
      updated_at: new Date().toISOString()
    };

    const { error } = await db
      .from('system_settings')
      .upsert({ id: 1, ...updateData }, { onConflict: 'id' });

    if (error) throw error;
    console.log("💾 Settings saved successfully to Supabase system_settings table.");
    return true;
  } catch (e) {
    console.error("❌ Error writing settings to DB:", e);
    return false;
  }
}

module.exports = {
  getSettings,
  saveSettings
};
