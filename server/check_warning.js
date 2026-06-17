const { db } = require('./database');

async function checkTicket() {
  const { data, error } = await db
    .from('refund_applications')
    .select('*')
    .eq('ticket_number', '5559078651090');
    
  if (error) {
    console.error("Error:", error);
  } else {
    console.log("Ticket details:", JSON.stringify(data, null, 2));
  }
}

checkTicket().then(() => process.exit(0));
