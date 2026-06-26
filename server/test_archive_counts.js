const { db } = require('./database');

async function test() {
  const validators = ['13MBA', '23280832 БЕРЛИН'];
  
  for (const val of validators) {
    const { data: activeCount } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('validator', val)
      .eq('is_archived', false);
      
    const { data: archivedCount } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('is_archived', true);
      
    const { data: totalCount } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('validator', val);

    console.log(`Validator '${val}':`);
    console.log(`  - Active (is_archived=false): ${activeCount || 0}`);
    console.log(`  - Archived (is_archived=true): ${archivedCount || 0} (global count)`);
    console.log(`  - Total: ${totalCount || 0}`);
    
    // Let's get specific archived count for this validator
    const { data: thisArchived } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('validator', val)
      .eq('is_archived', true);
    console.log(`  - Archived for this validator: ${thisArchived || 0}`);
  }
  
  process.exit(0);
}

test();
