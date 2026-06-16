const { createClient } = require('@supabase/supabase-js');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ Critical: SUPABASE_URL or SUPABASE_KEY is missing in environment!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false
  }
});

// For compatibility with imports in notifications.js
const db = supabase;

async function initDb() {
  try {
    // Quick test query to verify connection
    const { data, error } = await supabase.from('validators').select('code').limit(1);
    if (error) {
      throw error;
    }
    console.log("⚡ Successfully connected to remote Supabase Postgres database.");
    return true;
  } catch (error) {
    console.error("❌ Remote Supabase database connection failed:", error.message);
    throw error;
  }
}

module.exports = {
  db, // Export as db for compatibility, or use supabase directly
  supabase,
  initDb
};
