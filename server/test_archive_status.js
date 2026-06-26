const { db } = require('./database');

async function test() {
  const validators = ['13MBA', '23280832 БЕРЛИН'];
  
  for (const val of validators) {
    const { count: activeCount } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('validator', val)
      .eq('is_archived', false);
      
    const { count: archivedCount } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('validator', val)
      .eq('is_archived', true);
      
    const { count: totalCount } = await db
      .from('refund_applications')
      .select('*', { count: 'exact', head: true })
      .eq('validator', val);

    console.log(`Validator '${val}':`);
    console.log(`  - Active (is_archived=false): ${activeCount || 0}`);
    console.log(`  - Archived (is_archived=true): ${archivedCount || 0}`);
    console.log(`  - Total: ${totalCount || 0}`);
  }
  
  process.exit(0);
}

test();
