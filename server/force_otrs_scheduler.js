/**
 * Force scheduler run for otrs_reminders.
 * 1. Clears previous inactivity alert logs for all otrs_reminders operators to reset the 30-day filter.
 * 2. Runs the inactivity notifier for all eligible otrs_reminders tickets.
 * 3. Sends alerts directly to Rocket.Chat #otrs_reminders channel with Ticket and RA number info.
 * 4. Logs all alerts to the DB with today's date to start the 30-day countdown from now.
 * 
 * Run command:
 *   node server/force_otrs_scheduler.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { db, initDb } = require('./database');
const { notifyInactivity } = require('./notifications');

async function run() {
  console.log("⏰ Starting FULL OTRS_REMINDERS Scheduler Run...");
  
  try {
    await initDb();
    
    // 1. Fetch all users mapped to otrs_reminders
    const { data: users, error: uErr } = await db
      .from('users')
      .select('full_name, rocketchat_username, email')
      .eq('rocketchat_username', '@otrs_reminders');
      
    if (uErr) throw uErr;
    
    const otrsNames = users.map(u => u.full_name);
    console.log(`Found ${otrsNames.length} operator names mapped to @otrs_reminders.`);

    // 2. Clear old inactivity alert logs for these operators from inapp_notifications
    console.log("🧹 Clearing old inactivity alerts from database to reset 30-day filter for OTRS...");
    const { error: delErr } = await db
      .from('inapp_notifications')
      .delete()
      .in('recipient', otrsNames)
      .like('message', '%Нет изменений%');
      
    if (delErr) {
      console.warn("⚠️ Warning: could not clear old alerts:", delErr.message);
    } else {
      console.log("✅ Old alert history successfully cleared.");
    }

    // 3. Find all tickets older than 90 days but younger than 2 years
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

    if (refErr) throw refErr;

    console.log(`Found ${rows.length} total inactive tickets in DB.`);

    // 4. Fetch all users to resolve their contact details dynamically
    const { data: allUsers, error: allUsersErr } = await db
      .from('users')
      .select('username, full_name, email, rocketchat_username');
      
    if (allUsersErr) throw allUsersErr;

    // Filter otrs_reminders tickets
    const otrsTickets = [];
    for (const row of rows) {
      const operatorName = row.requested_by;
      let operatorRocketChat = row.operator_rocketchat;
      let operatorEmail = row.operator_email;

      if (operatorName) {
        const opUser = allUsers.find(u => u.full_name.toLowerCase().trim() === operatorName.toLowerCase().trim());
        if (opUser) {
          if (!operatorRocketChat) operatorRocketChat = opUser.rocketchat_username;
          if (!operatorEmail) operatorEmail = opUser.email;
        }
      }

      const isOtrs = operatorRocketChat && (operatorRocketChat === '@otrs_reminders' || operatorRocketChat === 'otrs_reminders');
      if (isOtrs) {
        otrsTickets.push({ row, operatorRocketChat, operatorEmail });
      }
    }

    console.log(`Found ${otrsTickets.length} tickets belonging to otrs_reminders.`);
    
    // 5. Send alerts for all tickets
    let sentCount = 0;
    for (let i = 0; i < otrsTickets.length; i++) {
      const { row, operatorRocketChat, operatorEmail } = otrsTickets[i];
      const ticketNumber = row.ticket_number;
      const operatorName = row.requested_by;
      const amount = row.amount;
      const currency = row.currency;

      const updatedDate = new Date(row.request_date);
      const today = new Date();
      const diffTime = Math.abs(today - updatedDate);
      const daysInactive = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      console.log(`[${i+1}/${otrsTickets.length}] Sending alert for ticket ${ticketNumber} (${daysInactive} days inactive)...`);
      
      try {
        await notifyInactivity({
          ticketNumber,
          daysInactive,
          operatorEmail,
          operatorRocketChat,
          operatorName,
          amount,
          currency,
          raNumber: row.bsp_request_number || row.tch_request_number || 'нет'
        });
        sentCount++;
      } catch (err) {
        console.error(`  ❌ Failed to send for ticket ${ticketNumber}:`, err.message);
      }
      
      // Small pause to prevent hitting API rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`\n==================================================`);
    console.log(`🏁 OTRS Full Run Finished. Total alerts sent: ${sentCount}`);
    console.log(`==================================================`);
    process.exit(0);

  } catch (err) {
    console.error("❌ Force scheduler crashed:", err.message);
    process.exit(1);
  }
}

run();
