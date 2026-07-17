/**
 * Migration script to merge duplicate operator accounts and reassociate their RA tickets.
 * 
 * Run options:
 *   node server/merge_users.js          -- Run in DRY-RUN mode (safe, no changes)
 *   node server/merge_users.js --commit -- Run in COMMIT mode (modifies DB)
 */

const { db } = require('./database');

const commit = process.argv.includes('--commit');
console.log(`🚀 RUNNING MIGRATION IN ${commit ? 'COMMIT' : 'DRY-RUN (READ-ONLY)'} MODE...`);

// Explicit mapping of duplicate groups to keep/merge
const MERGE_MAP = {
  '@i.prokuda': {
    keep: 'prokuda',
    fullName: 'Прокуда Ирина',
    aliases: ['Прокуда', 'Панченко']
  },
  '@a.vahrameeva': {
    keep: 'tokareva',
    fullName: 'Токарева Анна',
    aliases: ['Токарева', 'Вахрамеева']
  },
  '@i.sheina': {
    keep: 'sheina',
    fullName: 'Шеина Ирина',
    aliases: ['Шеина', 'Большакова']
  },
  '@s.mirdzhalilova': {
    keep: 'mirdzhalilova',
    fullName: 'Мирджалилова Саида',
    aliases: ['Мирджалилова', 'Мерджалилова']
  },
  '@e.melyakova': {
    keep: 'melyakova',
    fullName: 'Мелякова Екатерина',
    aliases: ['Мелякова', 'Катя']
  },
  '@al.scherbakova': {
    keep: 'sysoeva',
    fullName: 'Щербакова Александра',
    aliases: ['Сысоева', 'Cысоева']
  },
  '@e.pischulina': {
    keep: 'pishchulina',
    fullName: 'Пищулина Елена',
    aliases: ['Пищулина', 'Пищулипа']
  },
  '@a.krasnova': {
    keep: 'krasnova',
    fullName: 'Краснова Анна',
    aliases: ['Краснова', 'Крансова']
  },
  '@v.kostousova': {
    keep: 'kostousova',
    fullName: 'Костоусова Вера',
    aliases: ['Костоусова', 'Котсоусова']
  },
  '@s.kazhanova': {
    keep: 'kazhanova',
    fullName: 'Кажанова Светлана',
    aliases: ['Кажанова', 'Кжанова']
  },
  '@e.devyatova': {
    keep: 'bogdanova',
    fullName: 'Богданова Елена',
    aliases: ['Девятова', 'Девятовв', 'Богданова']
  },
  '@t.normukhamedov': {
    keep: 'normukhamedov',
    fullName: 'Нормухамедов Тимур',
    aliases: ['Нормухамедов', 'Нормухмаедов']
  },
  '@j.pronina': {
    keep: 'pronina',
    fullName: 'Пронина Юлия',
    aliases: ['Пронина', 'Савиткина']
  },
  '@a.schetinin': {
    keep: 'shchetinin',
    fullName: 'Щетинин Александр',
    aliases: ['Щетинин', 'Щетинини']
  },
  '@t.kucherova': {
    keep: 'kucherova',
    fullName: 'Кучерова Татьяна',
    aliases: ['Кучерова', 'Мазярова']
  },
  '@s.vasina': {
    keep: 'vasina',
    fullName: 'Васина Светлана',
    aliases: ['Васина', 'Васинасо']
  },
  '@e.litus': {
    keep: 'litus',
    fullName: 'Литус Екатерина',
    aliases: ['Литус', 'Маммедова', 'Маммедов']
  },
  '@i.alekseeva': {
    keep: 'moskvitina',
    fullName: 'Москвитина Ирина',
    aliases: ['Москвитина', 'Алексеева']
  },
  '@t.volkova': {
    keep: 'volkova',
    fullName: 'Волкова Татьяна',
    aliases: ['Волкова', 'Волковат']
  },
  '@a.eremenko': {
    keep: 'eremenko',
    fullName: 'Еременко Александр',
    aliases: ['Еременко', 'Ееменко']
  }
};

async function run() {
  try {
    // 1. Fetch all users from the DB
    const { data: dbUsers, error: usersErr } = await db.from('users').select('*');
    if (usersErr) throw usersErr;

    console.log(`Fetched ${dbUsers.length} user records.`);

    // Map by username for easy lookup
    const usersMap = {};
    dbUsers.forEach(u => {
      usersMap[u.username] = u;
    });

    let totalRAsUpdated = 0;
    let totalHistoryUpdated = 0;
    let totalUsersDeleted = 0;

    for (const [rc, config] of Object.entries(MERGE_MAP)) {
      console.log(`\n==================================================`);
      console.log(`👥 Group: ${rc} -> Target Unified Name: "${config.fullName}"`);

      // Find the user object to keep
      const keepUserObj = usersMap[config.keep];
      if (!keepUserObj) {
        console.error(`❌ Critical error: Kept user "${config.keep}" not found in DB! Skipping group.`);
        continue;
      }

      console.log(`  - Target Account: ID ${keepUserObj.id}, username "${keepUserObj.username}", current name "${keepUserObj.full_name}"`);

      // Find other duplicate accounts in the DB for this group (matching either the rocket_chat ID or aliases)
      const duplicateUsers = dbUsers.filter(u => {
        if (u.id === keepUserObj.id) return false;
        // Match if sharing same rocketchat_username
        if (u.rocketchat_username === rc) return true;
        // Or if username is in the aliases list
        if (config.aliases.map(a => a.toLowerCase()).includes(u.full_name.toLowerCase())) return true;
        return false;
      });

      console.log(`  - Duplicate accounts to merge and delete: ${duplicateUsers.length}`);
      duplicateUsers.forEach(du => {
        console.log(`    * ID ${du.id}, username "${du.username}", name "${du.full_name}"`);
      });

      // Update Target User in DB
      if (keepUserObj.full_name !== config.fullName) {
        console.log(`  - ACTION: Update full_name to "${config.fullName}" for username "${config.keep}"`);
        if (commit) {
          const { error: updErr } = await db
            .from('users')
            .update({ full_name: config.fullName })
            .eq('id', keepUserObj.id);
          if (updErr) console.error(`    ❌ Update user error: ${updErr.message}`);
          else console.log(`    ✅ Updated successfully.`);
        }
      }

      // Reassociate refund_applications
      // We will look for RAs where requested_by is in our aliases list
      for (const alias of config.aliases) {
        // Query to see how many RAs would be affected
        const { data: raRows, error: raErr } = await db
          .from('refund_applications')
          .select('id, ticket_number, requested_by, operator_rocketchat')
          .eq('requested_by', alias);

        if (raErr) {
          console.error(`    ❌ Query RAs error for alias "${alias}": ${raErr.message}`);
          continue;
        }

        if (raRows && raRows.length > 0) {
          console.log(`  - ACTION: Reassociate ${raRows.length} RAs matching requested_by = "${alias}"`);
          if (commit) {
            const { error: raUpdErr } = await db
              .from('refund_applications')
              .update({
                requested_by: config.fullName,
                operator_rocketchat: rc
              })
              .eq('requested_by', alias);

            if (raUpdErr) {
              console.error(`    ❌ Reassociate RAs error: ${raUpdErr.message}`);
            } else {
              console.log(`    ✅ Reassociated successfully.`);
              totalRAsUpdated += raRows.length;
            }
          } else {
            totalRAsUpdated += raRows.length;
          }
        }
      }

      // Reassociate status_history
      for (const alias of config.aliases) {
        const { data: histRows, error: histErr } = await db
          .from('status_history')
          .select('id, changed_by')
          .eq('changed_by', alias);

        if (histErr) {
          console.error(`    ❌ Query status history error for alias "${alias}": ${histErr.message}`);
          continue;
        }

        if (histRows && histRows.length > 0) {
          console.log(`  - ACTION: Reassociate ${histRows.length} history records matching changed_by = "${alias}"`);
          if (commit) {
            const { error: histUpdErr } = await db
              .from('status_history')
              .update({ changed_by: config.fullName })
              .eq('changed_by', alias);

            if (histUpdErr) {
              console.error(`    ❌ Reassociate history error: ${histUpdErr.message}`);
            } else {
              console.log(`    ✅ Reassociated successfully.`);
              totalHistoryUpdated += histRows.length;
            }
          } else {
            totalHistoryUpdated += histRows.length;
          }
        }
      }

      // Delete duplicate accounts from users table
      if (duplicateUsers.length > 0) {
        console.log(`  - ACTION: Delete duplicate user accounts`);
        if (commit) {
          const deleteIds = duplicateUsers.map(du => du.id);
          const { error: delErr } = await db
            .from('users')
            .delete()
            .in('id', deleteIds);

          if (delErr) {
            console.error(`    ❌ Delete user error: ${delErr.message}`);
          } else {
            console.log(`    ✅ Deleted successfully.`);
            totalUsersDeleted += deleteIds.length;
          }
        } else {
          totalUsersDeleted += duplicateUsers.length;
        }
      }
    }

    console.log(`\n==================================================`);
    console.log(`📊 MIGRATION SUMMARY:`);
    console.log(`  - Total refund applications updated:  ${totalRAsUpdated}`);
    console.log(`  - Total history logs updated:         ${totalHistoryUpdated}`);
    console.log(`  - Total duplicate users deleted:      ${totalUsersDeleted}`);
    console.log(`==================================================`);

    process.exit(0);
  } catch (err) {
    console.error(`❌ Migration failed:`, err.message);
    process.exit(1);
  }
}

run();
