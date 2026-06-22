const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const { db } = require('./database');
const { getSettings } = require('./settings_manager');

const LOG_FILE = path.join(__dirname, 'notifications_log.txt');

// Helper to write notifications to a log file when SMTP/RC is not configured
function logNotificationToFile(type, details) {
  const logMessage = `[${new Date().toISOString()}] [${type.toUpperCase()}]
Details: ${JSON.stringify(details, null, 2)}
--------------------------------------------------------------------------------\n`;
  fs.appendFileSync(LOG_FILE, logMessage, 'utf8');
  console.log(`📣 Notification logged to notifications_log.txt (${type})`);
}

// 1. Send Email Notification
async function sendEmailNotification(to, subject, htmlBody, customSettings) {
  const config = customSettings || await getSettings();

  if (!config.smtp_host || !config.smtp_user) {
    logNotificationToFile('email', { to, subject, body: htmlBody.replace(/<[^>]*>/g, '') });
    return { success: true, mocked: true };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: parseInt(config.smtp_port || '587'),
      secure: config.smtp_secure === true || config.smtp_secure === 'true',
      auth: {
        user: config.smtp_user,
        pass: config.smtp_pass,
      },
    });

    const info = await transporter.sendMail({
      from: config.smtp_from || config.smtp_user,
      to,
      subject,
      html: htmlBody,
    });

    console.log(`✉️ Email notification sent: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error sending email notification:', error);
    logNotificationToFile('email-error', { error: error.message, to, subject });
    throw error;
  }
}

// 2. Send Rocket Chat Notification
async function sendRocketChatNotification(message, recipient, customSettings) {
  const config = customSettings || await getSettings();
  const rcUrl = config.rocketchat_url;
  const rcToken = config.rocketchat_token;
  const rcUser = config.rocketchat_user;
  let rcChannel = recipient || config.rocketchat_channel || '#refund-alerts';

  // Auto-prepend '@' for usernames if missing prefix
  if (rcChannel && !rcChannel.startsWith('#') && !rcChannel.startsWith('@')) {
    rcChannel = `@${rcChannel}`;
  }

  if (!rcUrl) {
    logNotificationToFile('rocket_chat', { channel: rcChannel, message });
    return { success: true, mocked: true };
  }

  try {
    const isWebhook = rcUrl.includes('/hooks/');
    
    if (isWebhook) {
      // Incoming Webhook Integration
      const response = await fetch(rcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: message,
          channel: rcChannel
        })
      });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      console.log(`💬 Rocket Chat notification sent via Webhook to channel ${rcChannel}`);
      return { success: true };
    } else {
      // REST API Integration
      const apiEndpoint = `${rcUrl.replace(/\/$/, '')}/api/v1/chat.postMessage`;
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Auth-Token': rcToken,
          'X-User-Id': rcUser
        },
        body: JSON.stringify({
          channel: rcChannel,
          text: message
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Unknown REST API error');
      }

      console.log(`💬 Rocket Chat notification sent via REST API to ${rcChannel}`);
      return { success: true };
    }
  } catch (error) {
    console.error('❌ Error sending Rocket Chat notification:', error);
    logNotificationToFile('rocketchat-error', { error: error.message, message, recipient: rcChannel });
    throw error;
  }
}

// 3. Add In-App Notification (Bell icon) using Supabase
async function addInAppNotification(recipient, ticketNumber, message) {
  try {
    const { data, error } = await db
      .from('inapp_notifications')
      .insert([
        {
          recipient,
          ticket_number: ticketNumber,
          message,
          is_read: 0
        }
      ])
      .select('id');

    if (error) {
      throw error;
    }
    console.log(`🔔 In-app notification added for operator: ${recipient}`);
    return data[0]?.id;
  } catch (err) {
    console.error('❌ Error saving in-app notification:', err);
    throw err;
  }
}

// 4. Combined Notification Trigger when Status Changes
async function notifyStatusChange({ ticketNumber, oldStatus, newStatus, changedBy, comment, operatorEmail, operatorRocketChat, operatorName, amount, currency, authorizedAmount, systemType, bspRequestNumber, tchRequestNumber, refundType, supportTicket }) {
  const commentSection = comment ? `\n\n**Комментарий:**\n${comment}` : '';
  const commentHtml = comment ? `<p><strong>Комментарий:</strong><br/>${comment.replace(/\n/g, '<br/>')}</p>` : '<p><i>Комментарий не указан.</i></p>';

  let amountDetailsText = `Заявленная сумма: *${amount} ${currency}*`;
  let amountDetailsHtml = `<p>Заявленная сумма: <strong>${amount} ${currency}</strong></p>`;

  if (newStatus === 'авторизовано с расхождением') {
    amountDetailsText = `Заявлено: *${amount} ${currency}*\n*Авторизовано по факту: ${authorizedAmount} ${currency}*`;
    amountDetailsHtml = `<p>Заявлено: <strong>${amount} ${currency}</strong><br/><strong>Авторизовано по факту: <span style="color: #06b6d4;">${authorizedAmount} ${currency}</span></strong></p>`;
  }

  // Format RA details
  let raDetailsText = '';
  let raDetailsHtml = '';
  if (systemType === 'BSP Link' && bspRequestNumber) {
    raDetailsText = `\nСистема: *BSP Link*\nНомер запроса BSP: \`${bspRequestNumber}\``;
    raDetailsHtml = `<p>Система: <strong>BSP Link</strong><br/>Номер запроса BSP: <strong>${bspRequestNumber}</strong></p>`;
  } else if (systemType === 'TCH Connect' && tchRequestNumber) {
    raDetailsText = `\nСистема: *TCH Connect*\nНомер запроса TCH: \`${tchRequestNumber}\``;
    raDetailsHtml = `<p>Система: <strong>TCH Connect</strong><br/>Номер запроса TCH: <strong>${tchRequestNumber}</strong></p>`;
  }

  // Text message for Rocket Chat (with mention)
  let mention = '';
  if (operatorRocketChat) {
    mention = operatorRocketChat.startsWith('@') ? `${operatorRocketChat} ` : `@${operatorRocketChat} `;
  }
  const rcMessage = `🔔 *Изменение статуса возврата!*\n` +
                    `${mention}Билет: \`${ticketNumber}\` (Тикет: \`${supportTicket || '—'}\`)\n` +
                    `Вид возврата: *${refundType || '—'}*` +
                    `${raDetailsText}\n` +
                    `Статус: *${oldStatus || 'Создан'}* ➡️ *${newStatus}*\n` +
                    `${amountDetailsText}\n` +
                    `Изменил: ${changedBy}${commentSection}`;

  // HTML message for Email
  const emailSubject = `Изменение статуса возврата по билету ${ticketNumber}`;
  const emailHtml = `
    <h2>Изменение статуса Refund Application</h2>
    <p>Уважаемый оператор,</p>
    <p>Статус запроса на возврат по билету <strong>${ticketNumber}</strong> (Номер тикета: <strong>${supportTicket || '—'}</strong>) был изменен:</p>
    <p>Вид возврата: <strong>${refundType || '—'}</strong></p>
    ${raDetailsHtml}
    <p style="font-size: 16px; background-color: #f3f4f6; padding: 10px; border-radius: 5px; border-left: 4px solid #3b82f6;">
      <strong>${oldStatus || 'Создан'}</strong> &rarr; <strong>${newStatus}</strong>
    </p>
    ${amountDetailsHtml}
    <p>Изменения внес: <strong>${changedBy}</strong></p>
    ${commentHtml}
    <hr/>
    <p style="font-size: 12px; color: #6b7280;">Это автоматическое уведомление. Пожалуйста, не отвечайте на это письмо.</p>
  `;

  const discrepancyText = newStatus === 'авторизовано с расхождением' ? ` (факт: ${authorizedAmount} ${currency})` : '';
  const inAppMessage = `Статус изменен на "${newStatus}"${discrepancyText} (изменил: ${changedBy})${comment ? ': ' + comment.substring(0, 30) + '...' : ''}`;

  await Promise.all([
    // Email
    operatorEmail ? sendEmailNotification(operatorEmail, emailSubject, emailHtml).catch(e => console.error("Email notify err ignored:", e.message)) : Promise.resolve(),
    // Rocket Chat
    sendRocketChatNotification(rcMessage, operatorRocketChat).catch(e => console.error("RC notify err:", e.message)),
    // In-app Bell
    operatorName ? addInAppNotification(operatorName, ticketNumber, inAppMessage).catch(e => console.error("InApp notify err:", e.message)) : Promise.resolve()
  ]);
}

// 5. Combined Notification Trigger for Inactivity Warning (3 months)
async function notifyInactivity({ ticketNumber, daysInactive, operatorEmail, operatorRocketChat, operatorName, amount, currency }) {
  let mention = '';
  if (operatorRocketChat) {
    mention = operatorRocketChat.startsWith('@') ? `${operatorRocketChat} ` : `@${operatorRocketChat} `;
  }
  const rcMessage = `⚠️ *ПРЕДУПРЕЖДЕНИЕ О ПРОСТОЕ!*\n` +
                    `${mention}Билет: \`${ticketNumber}\` (${amount} ${currency})\n` +
                    `Статус не менялся уже *${daysInactive} дней*.\n` +
                    `Требуется проверка!`;

  const emailSubject = `ВНИМАНИЕ: Простой возврата по билету ${ticketNumber}`;
  const emailHtml = `
    <h2>Предупреждение о простое Refund Application</h2>
    <p>Уважаемый оператор,</p>
    <p>Статус запроса на возврат по билету <strong>${ticketNumber}</strong> (заявленная сумма: <strong>${amount} ${currency}</strong>) не обновлялся уже <strong>${daysInactive} дней</strong>.</p>
    <p>Пожалуйста, проверьте статус в системах BSP Link / TCH Connect и обновите заявку.</p>
    <hr/>
    <p style="font-size: 12px; color: #6b7280;">Это автоматическое уведомление планировщика задач.</p>
  `;

  const inAppMessage = `Внимание! Нет изменений статуса более ${daysInactive} дней! (${amount} ${currency})`;

  await Promise.all([
    operatorEmail ? sendEmailNotification(operatorEmail, emailSubject, emailHtml).catch(e => console.error("Email warn err:", e.message)) : Promise.resolve(),
    sendRocketChatNotification(rcMessage, operatorRocketChat).catch(e => console.error("RC warn err:", e.message)),
    operatorName ? addInAppNotification(operatorName, ticketNumber, inAppMessage).catch(e => console.error("InApp warn err:", e.message)) : Promise.resolve()
  ]);
}

// 6. Sync Ticket to Google Sheets Webhook (Passing full metadata payload)
async function syncToGoogleSheets(payload) {
  const config = await getSettings();
  const webhookUrl = config.google_sheets_webhook;

  if (!webhookUrl) {
    console.log("ℹ️ Google Sheets Webhook is not configured. Skipping sync.");
    return { success: true, skipped: true };
  }

  try {
    console.log(`⏳ Syncing action "${payload.action}" for ticket ${payload.ticket.ticket_number} (ID: ${payload.ticket.id}) to Google Sheets...`);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    console.log(`✅ Ticket ${payload.ticket.ticket_number} ("${payload.action}") successfully synced to Google Sheets.`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error syncing to Google Sheets for ticket ${payload.ticket.ticket_number}:`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendEmailNotification,
  sendRocketChatNotification,
  addInAppNotification,
  notifyStatusChange,
  notifyInactivity,
  syncToGoogleSheets
};
