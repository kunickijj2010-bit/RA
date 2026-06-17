const path = require('path');
// Load environment variables
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { db, initDb } = require('./database');
const { notifyInactivity } = require('./notifications');

async function runScheduler() {
  console.log("⏰ Running Daily Inactivity Scheduler...");
  
  try {
    await initDb();
    
    // Find tickets in intermediate statuses 
    // where status_updated_at is older than 90 days (3 months)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const dateStr = ninetyDaysAgo.toISOString().split('T')[0];

    const { data: rows, error: refErr } = await db
      .from('refund_applications')
      .select('*')
      .not('status', 'in', '("Авторизовано","Отклонено","авторизовано с расхождением")')
      .lte('status_updated_at', dateStr);

    if (refErr) {
      console.error("❌ Scheduler DB error:", refErr);
      process.exit(1);
    }

    console.log(`Found ${rows.length} tickets inactive for 90+ days.`);
    
    for (const row of rows) {
      const ticketNumber = row.ticket_number;
      const operatorName = row.requested_by;
      const operatorEmail = row.operator_email;
      const operatorRocketChat = row.operator_rocketchat;
      const amount = row.amount;
      const currency = row.currency;

      // Calculate days inactive using Javascript dates
      const updatedDate = new Date(row.status_updated_at);
      const today = new Date();
      const diffTime = Math.abs(today - updatedDate);
      const daysInactive = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      // Check if we already sent an inactivity alert for this ticket in the last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const thirtyDaysAgoStr = thirtyDaysAgo.toISOString();

      const { count: alertCount, error: alertErr } = await db
        .from('inapp_notifications')
        .select('*', { count: 'exact', head: true })
        .eq('ticket_number', ticketNumber)
        .like('message', '%Нет изменений%')
        .gte('created_at', thirtyDaysAgoStr);

      if (alertErr) {
        console.error(`Error checking alert history for ${ticketNumber}:`, alertErr);
        continue;
      }

      if (alertCount > 0) {
        console.log(`ℹ️ Inactivity alert for ticket ${ticketNumber} was already sent in the last 30 days. Skipping to avoid spam.`);
        continue;
      }

      console.log(`⚠️ Alerting for ticket ${ticketNumber}: inactive for ${daysInactive} days. Responsible: ${operatorName} (${operatorEmail || 'no email'})`);
      
      try {
        await notifyInactivity({
          ticketNumber,
          daysInactive,
          operatorEmail,
          operatorRocketChat,
          operatorName,
          amount,
          currency
        });
        console.log(`✅ Alert notifications successfully sent for ticket ${ticketNumber}`);
      } catch (notifErr) {
        console.error(`❌ Failed to send alert for ticket ${ticketNumber}:`, notifErr);
      }
    }
    
    console.log("⏰ Scheduler completed successfully.");
    process.exit(0);

  } catch (error) {
    console.error("❌ Scheduler error:", error);
    process.exit(1);
  }
}

// Execute scheduler
runScheduler();
