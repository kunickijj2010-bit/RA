const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { db } = require('./database');

const HTML_FILE_PATH = path.join(__dirname, '..', '..', 'sheet_page.html');

// Helper to transliterate Russian characters to Latin
function transliterate(str) {
  const ru = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'zh',
    'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o',
    'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
    'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ы': 'y', 'э': 'e', 'ю': 'yu', 'я': 'ya',
    'ь': '', 'ъ': ''
  };
  return str.toLowerCase().split('').map(char => ru[char] !== undefined ? ru[char] : char).join('');
}

// Generate login matching pattern initial.lastname
function generateUsername(fullName) {
  const cleanName = fullName.replace(/[^а-яА-Яa-zA-Z\s.]/g, '').trim();
  const parts = cleanName.split(/\s+/);
  
  if (parts.length >= 2) {
    // Determine last name and first name/initials
    let lastName = '';
    let initial = '';
    
    // Check if the first word has dots (Initials) or if it's the last name
    // Russian sheet standard is usually Lastname Initials (e.g. Анисимова О.А.)
    if (parts[1].includes('.') || parts[1].length <= 2) {
      lastName = transliterate(parts[0]).replace(/[^a-z]/g, '');
      initial = transliterate(parts[1][0]).replace(/[^a-z]/g, '');
    } else {
      // Lastname Firstname (e.g. Иванова Илона)
      lastName = transliterate(parts[0]).replace(/[^a-z]/g, '');
      initial = transliterate(parts[1][0]).replace(/[^a-z]/g, '');
    }
    
    if (!initial || !lastName) {
      return transliterate(cleanName).replace(/[^a-z.]/g, '');
    }
    return `${initial}.${lastName}`;
  } else {
    // Only one word (e.g. Шляхтун)
    return transliterate(parts[0]).replace(/[^a-z.]/g, '');
  }
}

// Map various sheet statuses to system statuses
function mapStatus(statusStr) {
  if (!statusStr || !statusStr.trim()) return 'Создан';
  const s = statusStr.trim().toLowerCase();
  if (s.includes('расхожд') || s.includes('расхождение')) {
    return 'авторизовано с расхождением';
  } else if (s.includes('авториз') || s === 'ок' || s === 'ok' || s.includes('проведен')) {
    return 'Авторизовано';
  } else if (s.includes('отклон') || s.includes('отказ')) {
    return 'Отклонено';
  } else if (s.includes('провер') || s.includes('на проверке')) {
    return 'На проверке';
  } else if (s.includes('создан')) {
    return 'Создан';
  }
  return 'Создан';
}

// Helper to parse dates in format dd.mm.yy or dd/mm/yyyy
function parseDate(dateStr) {
  if (!dateStr || !dateStr.trim()) return new Date().toISOString().split('T')[0];
  const cleaned = dateStr.trim();
  
  const m = cleaned.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/);
  if (m) {
    let day = parseInt(m[1]);
    let month = parseInt(m[2]);
    let year = parseInt(m[3]);
    if (year < 100) {
      year = year <= 40 ? 2000 + year : 1900 + year;
    }
    
    // Swap month/day if MM.DD.YYYY format
    if (month > 12 && day <= 12) {
      const temp = day;
      day = month;
      month = temp;
    }
    
    // Validate date parts range
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2100) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  
  // Try matching yyyy-mm-dd
  if (cleaned.match(/^\d{4}-\d{2}-\d{2}$/)) {
    const parts = cleaned.split('-');
    const y = parseInt(parts[0]);
    const m = parseInt(parts[1]);
    const d = parseInt(parts[2]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
      return cleaned;
    }
  }
  
  return new Date().toISOString().split('T')[0];
}

// Helper to parse amount and extract currency
function parseAmountCurrency(amountStr, defaultCurrency = 'EUR') {
  if (!amountStr || !amountStr.trim()) return { amount: 0, currency: defaultCurrency };
  const cleaned = amountStr.trim().replace(/\s/g, '').replace(/,/g, '.');
  
  const currencyMatch = cleaned.match(/(KZT|TRY|AED|RUB|EUR|USD|руб|TL|AED)/i);
  let currency = defaultCurrency;
  if (currencyMatch) {
    const cur = currencyMatch[1].toUpperCase();
    if (cur === 'РУБ') currency = 'RUB';
    else if (cur === 'TL') currency = 'TRY';
    else currency = cur;
  }
  
  const numMatch = cleaned.match(/[\d.]+/);
  let amount = numMatch ? parseFloat(numMatch[0]) : 0;
  if (isNaN(amount)) amount = 0;
  return { amount, currency };
}

// Parse equivalent
function parseEquivalent(equivStr) {
  if (!equivStr || !equivStr.trim()) return null;
  const cleaned = equivStr.trim().replace(/\s/g, '').replace(/,/g, '.');
  const numMatch = cleaned.match(/[\d.]+/);
  if (!numMatch) return null;
  const val = parseFloat(numMatch[0]);
  return isNaN(val) ? null : val;
}

// Built-in basic CSV Parser
function parseCSV(text) {
  const lines = [];
  let row = [];
  let inQuotes = false;
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i+1];
    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        cell += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      row.push(cell.trim());
      cell = '';
    } else if ((char === '\r' || char === '\n') && !inQuotes) {
      if (char === '\r' && nextChar === '\n') i++;
      row.push(cell.trim());
      lines.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell.trim());
    lines.push(row);
  }
  return lines;
}

// Main logic
async function run() {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`🚀 Starting Google Sheets Migration (${dryRun ? 'DRY RUN - SIMULATION' : 'REAL RUN'})`);

  if (!fs.existsSync(HTML_FILE_PATH)) {
    console.error(`❌ HTML File not found at: ${HTML_FILE_PATH}`);
    process.exit(1);
  }

  // 1. Fetch active validators from database
  console.log("Fetching validators from database...");
  const { data: dbValidators, error: valErr } = await db.from('validators').select('*');
  if (valErr) {
    console.error("❌ Failed to fetch validators:", valErr.message);
    process.exit(1);
  }
  console.log(`Found ${dbValidators.length} validators in database.`);

  // 2. Parse sheet titles and GIDs from HTML
  const html = fs.readFileSync(HTML_FILE_PATH, 'utf8');
  const pattern = /\\?"(\d{8,11})\\?",\s*\[\s*\{\s*\\?"1\\?"\s*:\s*\[\s*\[\s*0\s*,\s*0\s*,\s*\\?"([^"\\]+)\\?"/g;
  const mappings = [];
  let match;
  while ((match = pattern.exec(html)) !== null) {
    mappings.push({ gid: match[1], name: match[2].trim() });
  }

  console.log(`Discovered ${mappings.length} tabs in HTML metadata.`);

  // 3. For each sheet tab, find if it matches an active validator
  const activeTabs = [];
  for (const m of mappings) {
    // Extract digits from tab name
    const digitsMatch = m.name.match(/\d+/);
    let matchedValidator = null;

    if (digitsMatch) {
      const codeNum = digitsMatch[0];
      matchedValidator = dbValidators.find(v => v.code.includes(codeNum));
    } else {
      // Fuzzy string match
      const cleanTabName = m.name.toLowerCase().replace(/[^a-zа-я0-9]/g, '');
      matchedValidator = dbValidators.find(v => {
        const cleanCode = v.code.toLowerCase().replace(/[^a-zа-я0-9]/g, '');
        return cleanCode.includes(cleanTabName) || cleanTabName.includes(cleanCode);
      });
    }

    if (matchedValidator) {
      activeTabs.push({
        gid: m.gid,
        tabName: m.name,
        validatorCode: matchedValidator.code,
        systemType: matchedValidator.system_type
      });
    } else {
      console.log(`⚠️ Tab '${m.name}' skipped (no matching active validator found).`);
    }
  }

  console.log(`\nMatched ${activeTabs.length} tabs to active validators.`);

  // Fetch existing users to avoid duplicates
  const { data: dbUsers, error: usersErr } = await db.from('users').select('*');
  if (usersErr) {
    console.error("❌ Failed to fetch users:", usersErr.message);
    process.exit(1);
  }
  const existingUsernames = new Set(dbUsers.map(u => u.username));
  const existingFullNames = new Set(dbUsers.map(u => u.full_name));

  const newOperators = new Set();
  const rawApplications = [];

  // 4. Download and parse CSV files
  for (const tab of activeTabs) {
    console.log(`\nDownloading Tab '${tab.tabName}' (GID: ${tab.gid})...`);
    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/1vuozEZO8tqXysSmY9dyRk-kPVrEcND-3YiT2g66SGzY/export?format=csv&gid=${tab.gid}`;
      const res = await fetch(csvUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      
      const rows = parseCSV(text);
      if (rows.length < 2) {
        console.log(`  (Empty sheet, skipping)`);
        continue;
      }

      // Dynamic column mapping based on headers
      const header = rows[0];
      let colTicket = -1;
      let colOtrs = -1;
      let colRa = -1;
      let colDate = -1;
      let colAmount = -1;
      let colAgent = -1;
      let colOperator = -1;
      let colStatus = -1;
      let colStatusDate = -1;
      let colEquivalent = -1;
      let colModifier = -1;
      let colComment = -1;

      for (let idx = 0; idx < header.length; idx++) {
        const h = header[idx].toLowerCase().trim();
        if (!h) {
          if (idx === 0) colTicket = 0;
          else if (idx === 2) colRa = 2;
          continue;
        }
        
        // Ticket number check (must not match otrs ticket# or ticket_id)
        if (h.includes('билет') || h === 'ticket_number' || h === 'tkt') {
          colTicket = idx;
        }
        // OTRS ticket check
        else if (h.includes('тикет') || h.includes('ticket') || h.includes('otrs') || h.includes('номер заявки')) {
          colOtrs = idx;
        }
        // RA check (both Latin 'ra' and Cyrillic 'ра')
        const cleanH = h.replace(/[^a-zа-я0-9\s#]/g, '').trim();
        const isRaHeader = 
          cleanH === 'номер ра' ||
          cleanH === 'номер ra' ||
          cleanH === 'номер запроса' ||
          cleanH === 'refund number' ||
          cleanH === 'номер refund application' ||
          cleanH === 'ra' ||
          cleanH === 'ра' ||
          cleanH === 'запрос' ||
          cleanH === 'запроса' ||
          cleanH === 'refund application' ||
          cleanH === 'refund #' ||
          cleanH === 'номер запроса ра' ||
          cleanH === 'номер запроса ra' ||
          cleanH === '400504984' ||
          cleanH === '0400504984';

        if (isRaHeader) {
          colRa = idx;
        }
        
        // Date check
        if (h.includes('дата') || h.includes('date')) {
          if (colDate === -1) colDate = idx;
          else colStatusDate = idx;
        }
        // Amount check
        else if (h.includes('сумма') || h.includes('amount') || h.includes('price')) {
          colAmount = idx;
        }
        // Agent check
        else if ((h.includes('агент') || h.includes('agent')) && !h.includes('эквивалент') && !h.includes('equivalent')) {
          colAgent = idx;
        }
        // Operator check
        else if (h.includes('запросил') || h.includes('оператор') || h.includes('сотрудник') || h.includes('кем') || h.includes('кто') || h === 'user') {
          colOperator = idx;
        }
        // Status check
        else if (h.includes('авторизац') || h.includes('статус') || h.includes('status') || h.includes('решение')) {
          colStatus = idx;
        }
        // Equivalent check
        else if (h.includes('эквивалент') || h.includes('equivalent')) {
          colEquivalent = idx;
        }
        // Comment check
        else if (h.includes('коммент') || h.includes('примечан') || h.includes('comment') || h.includes('note')) {
          colComment = idx;
        }
      }

      // Fallbacks
      if (colTicket === -1) colTicket = 0;
      if (colRa === -1 && header.length > 2) colRa = 2;

      console.log(`  Mapping: ticket=${colTicket}, otrs=${colOtrs}, ra=${colRa}, date=${colDate}, amount=${colAmount}, agent=${colAgent}, operator=${colOperator}, status=${colStatus}, equiv=${colEquivalent}, comment=${colComment}`);

      // Determine default currency for the tab
      let defaultCurrency = 'EUR';
      if (tab.tabName.toLowerCase().includes('turkish') || tab.tabName.toLowerCase().includes('tl')) defaultCurrency = 'TRY';
      else if (tab.tabName.toLowerCase().includes('казахстан') || tab.tabName.toLowerCase().includes('kzt')) defaultCurrency = 'KZT';
      else if (tab.tabName.toLowerCase().includes('дубай') || tab.tabName.toLowerCase().includes('aed')) defaultCurrency = 'AED';

      let parsedCount = 0;
      for (let rIdx = 1; rIdx < rows.length; rIdx++) {
        const row = rows[rIdx];
        if (row.length === 0 || !row[0]) continue; // Skip empty rows

        const ticketRaw = colTicket !== -1 ? row[colTicket] : '';
        let ticketNum = ticketRaw.replace(/\D/g, '');
        if (!ticketNum || ticketNum.length < 10) continue; // Skip invalid ticket numbers
        if (ticketNum.length > 13) ticketNum = ticketNum.substring(0, 13);

        // Parse operator names
        const requestedBy = colOperator !== -1 && row[colOperator] ? row[colOperator].trim() : 'Система';
        const changedBy = colModifier !== -1 && row[colModifier] ? row[colModifier].trim() : '';

        if (requestedBy && requestedBy !== 'Система' && requestedBy !== 'СОФИ') newOperators.add(requestedBy);
        if (changedBy && changedBy !== 'Система' && changedBy !== 'СОФИ') newOperators.add(changedBy);

        // Parse amount and currency
        const rawAmountStr = colAmount !== -1 ? row[colAmount] : '';
        const { amount, currency } = parseAmountCurrency(rawAmountStr, defaultCurrency);

        // Parse status
        const rawStatus = colStatus !== -1 ? row[colStatus] : '';
        const status = mapStatus(rawStatus);

        // Parse dates
        const rawDate = colDate !== -1 ? row[colDate] : '';
        const requestDate = parseDate(rawDate);

        // Parse equivalent
        const rawEquiv = colEquivalent !== -1 ? row[colEquivalent] : '';
        const agentRefundEquivalent = parseEquivalent(rawEquiv);

        // Build refund application object
        const refundApplication = {
          ticket_number: ticketNum,
          system_type: tab.systemType,
          validator: tab.validatorCode,
          request_date: requestDate,
          amount,
          currency,
          agent_refund_equivalent: agentRefundEquivalent,
          agent_name: colAgent !== -1 && row[colAgent] ? row[colAgent].trim() : 'Неизвестный агент',
          requested_by: requestedBy,
          status,
          status_updated_at: colStatusDate !== -1 && row[colStatusDate] ? parseDate(row[colStatusDate]) : requestDate,
          support_ticket: colOtrs !== -1 && row[colOtrs] ? row[colOtrs].trim().replace(/\D/g, '') || '0' : '0',
          bsp_request_number: tab.systemType === 'BSP Link' && colRa !== -1 && row[colRa] ? row[colRa].trim().replace(/\D/g, '') : null,
          tch_request_number: tab.systemType === 'TCH Connect' && colRa !== -1 && row[colRa] ? row[colRa].trim().replace(/\D/g, '') : null,
          comment: colComment !== -1 && row[colComment] ? row[colComment].trim() : ''
        };

        rawApplications.push(refundApplication);
        parsedCount++;
      }

      console.log(`  Parsed ${parsedCount} applications successfully.`);
    } catch (err) {
      console.error(`  ❌ Error processing tab '${tab.tabName}':`, err.message);
    }
  }

  // 5. Register new operators as employees
  console.log(`\nCollected ${newOperators.size} unique operators from Sheet.`);
  const operatorsToInsert = [];
  const generatedLogins = new Set(dbUsers.map(u => u.username));

  for (const opName of newOperators) {
    if (existingFullNames.has(opName)) continue; // Already registered

    const baseUsername = generateUsername(opName);
    if (!baseUsername) continue;

    // Resolve duplicate usernames
    let finalUsername = baseUsername;
    let counter = 1;
    while (generatedLogins.has(finalUsername)) {
      finalUsername = `${baseUsername}${counter}`;
      counter++;
    }
    generatedLogins.add(finalUsername);

    const defaultPassword = `${finalUsername}123`;
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(defaultPassword, salt);

    operatorsToInsert.push({
      username: finalUsername,
      password_hash: passwordHash,
      full_name: opName,
      role: 'employee'
    });
  }

  console.log(`Operators ready to register: ${operatorsToInsert.length}`);
  if (operatorsToInsert.length > 0) {
    console.log("Sample accounts mapping:");
    operatorsToInsert.slice(0, 5).forEach(o => {
      console.log(`  - Name: '${o.full_name}' -> Login: '${o.username}', Pass: '${o.username}123'`);
    });
    if (operatorsToInsert.length > 5) console.log(`  ... and ${operatorsToInsert.length - 5} more.`);
  }

  // De-duplicate applications by ticket_number to avoid duplicate key issues within the same batch/run
  const uniqueAppsMap = new Map();
  for (const app of rawApplications) {
    if (!uniqueAppsMap.has(app.ticket_number)) {
      uniqueAppsMap.set(app.ticket_number, app);
    }
  }
  const deDuplicatedApplications = Array.from(uniqueAppsMap.values());
  console.log(`De-duplicated applications list: ${rawApplications.length} -> ${deDuplicatedApplications.length}`);

  // 6. DB Writing Phase
  if (dryRun) {
    console.log("\n================ DRY RUN SUMMARY ================");
    console.log(`Operators that would be added: ${operatorsToInsert.length}`);
    console.log(`Applications parsed and ready: ${deDuplicatedApplications.length}`);
    
    // Sample parsed row
    if (deDuplicatedApplications.length > 0) {
      console.log("Sample application item parsed:");
      console.log(JSON.stringify(deDuplicatedApplications[0], null, 2));
    }
    console.log("=================================================");
  } else {
    // A. Insert Operators
    if (operatorsToInsert.length > 0) {
      console.log("\nInserting operator accounts to 'users' table...");
      const { error: insErr } = await db.from('users').insert(operatorsToInsert);
      if (insErr) {
        console.error("❌ Failed to insert operators:", insErr.message);
      } else {
        console.log(`⚡ Registered ${operatorsToInsert.length} operator accounts successfully.`);
      }
    }

    // B. Insert Refund Applications (Batching of 200 items to fit PostgREST size limits)
    console.log(`\nInserting ${deDuplicatedApplications.length} refund applications...`);
    const batchSize = 200;
    let insertedCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < deDuplicatedApplications.length; i += batchSize) {
      const batch = deDuplicatedApplications.slice(i, i + batchSize);
      
      // PostgREST doesn't support 'ON CONFLICT DO NOTHING' directly in JSON payload standard,
      // but we can query existing ticket numbers in this batch, filter them out, and insert only the new ones.
      const batchTickets = batch.map(a => a.ticket_number);
      const { data: existingApps, error: chkErr } = await db
        .from('refund_applications')
        .select('ticket_number')
        .in('ticket_number', batchTickets);

      if (chkErr) {
        console.error("❌ Conflict checking failed:", chkErr.message);
        continue;
      }

      const existingSet = new Set(existingApps.map(a => a.ticket_number));
      const filteredBatch = batch.filter(a => !existingSet.has(a.ticket_number));
      
      skippedCount += (batch.length - filteredBatch.length);

      if (filteredBatch.length > 0) {
        // Exclude comment field from insert payload as it doesn't exist on refund_applications table
        const insertPayload = filteredBatch.map(({ comment, ...rest }) => rest);

        const { data: insertedApps, error: insertAppsErr } = await db
          .from('refund_applications')
          .insert(insertPayload)
          .select('id, ticket_number, status, requested_by');

        if (insertAppsErr) {
          console.error(`❌ Batch insert failed [${i} to ${i + batch.length}]:`, insertAppsErr.message);
        } else {
          insertedCount += filteredBatch.length;

          // Insert comments into status_history
          if (insertedApps && insertedApps.length > 0) {
            const historyBatch = [];
            for (const app of insertedApps) {
              const original = filteredBatch.find(a => a.ticket_number === app.ticket_number);
              const commentText = original && original.comment ? original.comment : 'Импорт из Google Sheets';
              historyBatch.push({
                application_id: app.id,
                old_status: null,
                new_status: app.status,
                changed_by: app.requested_by || 'Система',
                comment: commentText
              });
            }
            if (historyBatch.length > 0) {
              const { error: histErr } = await db.from('status_history').insert(historyBatch);
              if (histErr) {
                console.error(`  ⚠️ Warning: status history insert failed for batch starting at ${i}:`, histErr.message);
              }
            }
          }
        }
      }
    }

    console.log(`\n⚡ Migration completed!`);
    console.log(`   Total applications processed: ${deDuplicatedApplications.length}`);
    console.log(`   Successfully imported: ${insertedCount}`);
    console.log(`   Skipped (already exist): ${skippedCount}`);
  }

  process.exit(0);
}

run();
