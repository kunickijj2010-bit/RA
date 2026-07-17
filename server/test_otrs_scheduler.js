/**
 * Test script to force run inactivity warnings for otrs_reminders.
 * Bypasses the 30-day anti-spam filter but limits to exactly 3 messages to avoid spamming the channel.
 * 
 * Run command:
 *   node server/test_otrs_scheduler.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { db, initDb } = require('./database');
const { notifyInactivity } = require('./notifications');

async function runTest() {
  console.log("⏰ Running Inactivity Scheduler TEST RUN for otrs_reminders...");
  
  try {
    await initDb();
    
    // Find tickets older than 90 days but younger than 2 years
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const dateStr = ninetyDaysAgo.toISOString().split('T')[0];

    const twoYearsAgo = new Date();
    twoYearsAgo.setDate(twoYearsAgo.getDate() - 730);
    const maxAgeDateStr = twoYearsAgo.toISOString().split('T')[0];

    const { data: rows, error: refErr } = await db
      .from('refund_applications')
      .select('*')
      .in('status', ['Создан', 'На проверке'])
      .eq('is_archived', false)
      .lte('request_date', dateStr)
      .gte('request_date', maxAgeDateStr);

    if (refErr) {
      console.error("❌ DB query error:", refErr);
      process.exit(1);
    }

    // Fetch all users
    const { data: dbUsers, error: usersErr } = await db
      .from('users')
      .select('username, full_name, email, rocketchat_username');
    
    if (usersErr) {
      console.error("❌ Users query error:", usersErr);
      process.exit(1);
    }

    // Filter only otrs_reminders tickets
    const otrsRows = [];
    for (const row of rows) {
      const operatorName = row.requested_by;
      let operatorRocketChat = row.operator_rocketchat;
      let operatorEmail = row.operator_email;

      if (operatorName) {
        const opUser = dbUsers.find(u => u.full_name.toLowerCase().trim() === operatorName.toLowerCase().trim());
        if (opUser) {
          if (!operatorRocketChat) operatorRocketChat = opUser.rocketchat_username;
          if (!operatorEmail) operatorEmail = opUser.email;
        }
      }

      const isOtrs = operatorRocketChat && (operatorRocketChat === '@otrs_reminders' || operatorRocketChat === 'otrs_reminders');
      if (isOtrs) {
        otrsRows.push({ row, operatorRocketChat, operatorEmail });
      }
    }

    console.log(`Found total of ${otrsRows.length} tickets belonging to otrs_reminders.`);
    
    const limit = 3;
    const toProcess = otrsRows.slice(0, limit);
    
    console.log(`Processing first ${toProcess.length} tickets (bypassing 30-day filter for testing)...`);

    for (let i = 0; i < toProcess.length; i++) {
      const { row, operatorRocketChat, operatorEmail } = toProcess[i];
      const ticketNumber = row.ticket_number;
      const operatorName = row.requested_by;
      const amount = row.amount;
      const currency = row.currency;

      const updatedDate = new Date(row.request_date);
      const today = new Date();
      const diffTime = Math.abs(today - updatedDate);
      const daysInactive = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      console.log(`[${i+1}/${toProcess.length}] Sending alert for ticket ${ticketNumber} (${daysInactive} days inactive) to otrs_reminders...`);
      
      // Temporarily override isOtrs logic inside notifyInactivity by patching sendRocketChatNotification
      // Since operatorRocketChat is '@otrs_reminders', notifyInactivity will send it because isOtrs will be true
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
        console.log(`  ✅ Notification sent.`);
      } catch (err) {
        console.error(`  ❌ Failed:`, err.message);
      }
    }

    console.log("🏁 Test run finished.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Test scheduler crashed:", err.message);
    process.exit(1);
  }
}

runTest();
