const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

function getSettings() {
  // Default values from process.env if settings.json doesn't exist
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

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const fileContent = fs.readFileSync(SETTINGS_PATH, 'utf8');
      if (fileContent.trim()) {
        const fileData = JSON.parse(fileContent);
        settings = { ...settings, ...fileData };
      }
    } catch (e) {
      console.error("⚠️ Error reading settings.json, reverting to defaults:", e);
    }
  }
  return settings;
}

function saveSettings(newSettings) {
  try {
    const currentSettings = getSettings();
    
    // Merge new settings. If password is unchanged (comes as masked), preserve old password
    const merged = { ...currentSettings, ...newSettings };
    
    if (newSettings.smtp_pass === '••••••••') {
      merged.smtp_pass = currentSettings.smtp_pass;
    }
    if (newSettings.rocketchat_token === '••••••••') {
      merged.rocketchat_token = currentSettings.rocketchat_token;
    }

    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
    console.log("💾 Settings saved successfully to settings.json");
    return true;
  } catch (e) {
    console.error("❌ Error writing settings.json:", e);
    return false;
  }
}

module.exports = {
  getSettings,
  saveSettings
};
