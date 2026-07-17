/**
 * Script to batch-populate operator_rocketchat and operator_email for ALL tickets in refund_applications
 * based on the users table profiles.
 * 
 * Run options:
 *   node server/link_all_ras.js          -- Run in DRY-RUN mode (safe, no changes)
 *   node server/link_all_ras.js --commit -- Run in COMMIT mode (modifies DB)
 */

const { db } = require('./database');

const commit = process.argv.includes('--commit');
console.log(`🚀 RUNNING TICKET LINKING IN ${commit ? 'COMMIT' : 'DRY-RUN (READ-ONLY)'} MODE...`);

async function run() {
  try {
    // 1. Fetch all users
    const { data: dbUsers, error: usersErr } = await db
      .from('users')
      .select('username, full_name, email, rocketchat_username');
      
    if (usersErr) throw usersErr;

    console.log(`Fetched ${dbUsers.length} user records.`);

    let totalLinked = 0;

    for (const u of dbUsers) {
      if (!u.rocketchat_username && !u.email) {
        console.log(`⏭️ Skipping user "${u.full_name}" (no RocketChat or Email configured)`);
        continue;
      }

      // Query count of unlinked RAs for this user
      const { count, error: countErr } = await db
        .from('refund_applications')
        .select('*', { count: 'exact', head: true })
        .eq('requested_by', u.full_name)
        .or('operator_rocketchat.is.null,operator_email.is.null');

      if (countErr) {
        console.error(`❌ Count query error for "${u.full_name}":`, countErr.message);
        continue;
      }

      if (count > 0) {
        console.log(`🔗 Operator: "${u.full_name}" -> Matches ${count} unlinked tickets. Will set RC: "${u.rocketchat_username || 'none'}", Email: "${u.email || 'none'}"`);
        
        if (commit) {
          const { error: updErr } = await db
            .from('refund_applications')
            .update({
              operator_rocketchat: u.rocketchat_username || null,
              operator_email: u.email || null
            })
            .eq('requested_by', u.full_name);

          if (updErr) {
            console.error(`  ❌ Update error:`, updErr.message);
          } else {
            console.log(`  ✅ Successfully updated ${count} tickets.`);
            totalLinked += count;
          }
        } else {
          totalLinked += count;
        }
      }
    }

    console.log(`\n==================================================`);
    console.log(`📊 SUMMARY:`);
    console.log(`  - Total tickets linked/updated: ${totalLinked}`);
    console.log(`==================================================`);

    process.exit(0);
  } catch (err) {
    console.error(`❌ Linking failed:`, err.message);
    process.exit(1);
  }
}

run();
