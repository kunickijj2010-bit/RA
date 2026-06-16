const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'refunds.db');
const db = new sqlite3.Database(DB_PATH);

const NUM_TEST_INSERTS = 20000;

function runVerification() {
  console.log(`🧪 Starting automated verification test...`);
  console.log(`Seeding database with ${NUM_TEST_INSERTS} test rows for load simulation...`);

  db.serialize(() => {
    // Check baseline count
    db.get("SELECT COUNT(*) as count FROM refund_applications", (err, row) => {
      if (err) {
        console.error("❌ SQL count error:", err);
        process.exit(1);
      }
      console.log(`Current record count: ${row.count}`);
      
      // Bulk insert simulation
      const startTime = Date.now();
      db.run("BEGIN TRANSACTION");
      
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO refund_applications (
          ticket_number, bsp_request_number, tch_request_number, system_type,
          validator, request_date, amount_eur, agent_refund_equivalent,
          agent_name, requested_by, status, status_updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (let i = 0; i < NUM_TEST_INSERTS; i++) {
        const ticket = `999${String(i).padStart(10, '0')}`;
        const bsp = `2026${String(i).padStart(6, '0')}`;
        const amount = Math.round((50 + Math.random() * 500) * 100) / 100;
        stmt.run(
          ticket,
          bsp,
          null,
          "BSP Link",
          "SU",
          "2026-06-16",
          amount,
          amount * 90,
          "Emerging Travel Inc. (0CK9)",
          "Иванов И",
          "Создан",
          "2026-06-16"
        );
      }
      stmt.finalize();
      
      db.run("COMMIT", (commitErr) => {
        if (commitErr) {
          console.error("❌ Transaction commit error:", commitErr);
          process.exit(1);
        }
        
        const insertTime = Date.now() - startTime;
        console.log(`✅ Bulk inserted ${NUM_TEST_INSERTS} records in ${insertTime} ms (${(insertTime / NUM_TEST_INSERTS).toFixed(4)} ms/record)`);
        
        // Let's verify search query speed using INDEX
        console.log(`Testing query latency for indexed lookups (100 random queries)...`);
        const queryStart = Date.now();
        let queriesFinished = 0;
        
        for (let q = 0; q < 100; q++) {
          const randomIndex = Math.floor(Math.random() * NUM_TEST_INSERTS);
          const searchTicket = `999${String(randomIndex).padStart(10, '0')}`;
          
          db.get("SELECT * FROM refund_applications WHERE ticket_number = ?", [searchTicket], (queryErr, queryRow) => {
            if (queryErr) console.error("Query error:", queryErr);
            queriesFinished++;
            
            if (queriesFinished === 100) {
              const queryDuration = Date.now() - queryStart;
              const avgQueryTime = queryDuration / 100;
              console.log(`📊 Total query time for 100 lookups: ${queryDuration} ms`);
              console.log(`📊 Average query latency: ${avgQueryTime.toFixed(4)} ms per lookup`);
              
              if (avgQueryTime < 10) {
                console.log(`✅ VERIFICATION SUCCESSFUL: Query speed is outstanding (< 10ms)!`);
              } else {
                console.log(`⚠️ VERIFICATION WARNING: Query speed is slower than expected (> 10ms).`);
              }
              
              // Clean up test data to keep the database size clean for the user
              console.log("Cleaning up simulated test data...");
              db.run("DELETE FROM refund_applications WHERE ticket_number LIKE '999%'", (delErr) => {
                if (delErr) console.error("Clean up error:", delErr);
                console.log("🧹 Simulated test data deleted. Clean up complete.");
                db.close();
              });
            }
          });
        }
      });
    });
  });
}

runVerification();
